const { DatabaseSync } = require('node:sqlite');

function normalizeCatalogPrice(name, value) {
  const raw = String(value || '').trim();
  const priceMatch = raw.match(/^(\d+(?:\.\d+)?)\s*万(?:元)?$/);
  const modelSuffix = String(name || '').trim().match(/[a-z](\d{2,3})$/i);
  if (!priceMatch || !modelSuffix) return raw;

  const numericText = priceMatch[1];
  const prefix = modelSuffix[1];
  if (!numericText.startsWith(prefix) || numericText.length <= prefix.length) return raw;

  const repairedText = numericText.slice(prefix.length);
  const originalPrice = Number(numericText);
  const repairedPrice = Number(repairedText);
  if (originalPrice >= 100 && repairedPrice > 0 && repairedPrice < 100) {
    return repairedText + '万';
  }
  return raw;
}

function sameCatalogRows(current, incoming, fields) {
  if (current.length !== incoming.length) return false;
  return current.every((row, index) => fields.every(field =>
    String(row[field] ?? '') === String(incoming[index]?.[field] ?? '')
  ));
}

class DataStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS brands (
        category TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        initial TEXT NOT NULL,
        PRIMARY KEY (category, id)
      );
      CREATE TABLE IF NOT EXISTS series (
        category TEXT NOT NULL,
        brand_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (category, brand_id, id)
      );
      CREATE TABLE IF NOT EXISTS models (
        category TEXT NOT NULL,
        brand_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        id TEXT NOT NULL,
        year TEXT NOT NULL,
        name TEXT NOT NULL,
        min_registration_year TEXT NOT NULL,
        max_registration_year TEXT NOT NULL,
        PRIMARY KEY (category, brand_id, series_id, id)
      );
      CREATE TABLE IF NOT EXISTS provinces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cities (
        province_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (province_id, id),
        FOREIGN KEY (province_id) REFERENCES provinces(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS quotes (
        cache_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vehicle_photos (
        image_url TEXT PRIMARY KEY,
        image_data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_series_parent ON series(category, brand_id);
      CREATE INDEX IF NOT EXISTS idx_models_parent ON models(category, brand_id, series_id);
      CREATE INDEX IF NOT EXISTS idx_cities_parent ON cities(province_id, sort_order);
    `);
    if (!this.db.prepare('PRAGMA table_info(models)').all().some(column => column.name === 'catalog_price')) {
      this.db.exec('ALTER TABLE models ADD COLUMN catalog_price TEXT');
    }
  }

  transaction(task) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = task();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  timestamp(scope) {
    return this.db.prepare('SELECT updated_at FROM metadata WHERE key = ?').get(scope)?.updated_at || 0;
  }

  isFresh(scope, ttl) {
    return Date.now() - this.timestamp(scope) < ttl;
  }

  touch(scope, updatedAt = Date.now()) {
    this.db.prepare(`
      INSERT INTO metadata(key, updated_at) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at
    `).run(scope, updatedAt);
  }

  getBrands(category) {
    return this.db.prepare('SELECT id, name, initial FROM brands WHERE category = ? ORDER BY rowid').all(category);
  }

  replaceBrands(category, items) {
    const current = this.getBrands(category);
    if (sameCatalogRows(current, items, ['id', 'name', 'initial'])) {
      this.touch('brands:' + category);
      return false;
    }
    const insert = this.db.prepare('INSERT INTO brands(category, id, name, initial) VALUES (?, ?, ?, ?)');
    this.transaction(() => {
      const activeIds = new Set(items.map(item => String(item.id)));
      const removed = this.db.prepare('SELECT id FROM brands WHERE category = ?').all(category)
        .filter(item => !activeIds.has(String(item.id)));
      const deleteModels = this.db.prepare('DELETE FROM models WHERE category = ? AND brand_id = ?');
      const deleteSeries = this.db.prepare('DELETE FROM series WHERE category = ? AND brand_id = ?');
      removed.forEach(item => {
        deleteModels.run(category, item.id);
        deleteSeries.run(category, item.id);
      });
      this.db.prepare('DELETE FROM brands WHERE category = ?').run(category);
      items.forEach(item => insert.run(category, item.id, item.name, item.initial));
      this.touch('brands:' + category);
    });
    return true;
  }

  getSeries(category, brandId) {
    return this.db.prepare('SELECT id, name FROM series WHERE category = ? AND brand_id = ? ORDER BY rowid').all(category, brandId);
  }

  searchSeries(category, keyword, limit = 120) {
    const term = String(keyword || '').trim();
    const query = `%${term}%`;
    return this.db.prepare(`
      SELECT series.id, series.name, series.brand_id AS brandId,
             brands.name AS brandName, brands.initial AS brandInitial
      FROM series
      JOIN brands ON brands.category = series.category AND brands.id = series.brand_id
      WHERE series.category = ? AND (series.name LIKE ? OR brands.name LIKE ?)
      ORDER BY
        CASE
          WHEN series.name = ? THEN 0
          WHEN series.name LIKE ? THEN 1
          WHEN brands.name = ? THEN 2
          ELSE 3
        END,
        brands.rowid,
        series.rowid
      LIMIT ?
    `).all(category, query, query, term, `${term}%`, term, limit);
  }

  replaceSeries(category, brandId, items) {
    const current = this.getSeries(category, brandId);
    if (sameCatalogRows(current, items, ['id', 'name'])) {
      this.touch(`series:${category}:${brandId}`);
      return false;
    }
    const insert = this.db.prepare('INSERT INTO series(category, brand_id, id, name) VALUES (?, ?, ?, ?)');
    this.transaction(() => {
      const activeIds = new Set(items.map(item => String(item.id)));
      const removed = this.db.prepare('SELECT id FROM series WHERE category = ? AND brand_id = ?').all(category, brandId)
        .filter(item => !activeIds.has(String(item.id)));
      const deleteModels = this.db.prepare(
        'DELETE FROM models WHERE category = ? AND brand_id = ? AND series_id = ?'
      );
      removed.forEach(item => deleteModels.run(category, brandId, item.id));
      this.db.prepare('DELETE FROM series WHERE category = ? AND brand_id = ?').run(category, brandId);
      items.forEach(item => insert.run(category, brandId, item.id, item.name));
      this.touch(`series:${category}:${brandId}`);
    });
    return true;
  }

  getModels(category, brandId, seriesId) {
    const rows = this.db.prepare(`
      SELECT id, year, name, min_registration_year AS minRegistrationYear,
             max_registration_year AS maxRegistrationYear, catalog_price AS catalogPrice
      FROM models WHERE category = ? AND brand_id = ? AND series_id = ? ORDER BY rowid
    `).all(category, brandId, seriesId);
    const updatePrice = this.db.prepare(`
      UPDATE models SET catalog_price = ?
      WHERE category = ? AND brand_id = ? AND series_id = ? AND id = ?
    `);
    return rows.map(item => {
      const catalogPrice = normalizeCatalogPrice(item.name, item.catalogPrice);
      if (catalogPrice !== item.catalogPrice) {
        updatePrice.run(catalogPrice || null, category, brandId, seriesId, item.id);
      }
      return { ...item, catalogPrice };
    });
  }

  replaceModels(category, brandId, seriesId, items) {
    const normalizedItems = items.map(item => ({
      ...item,
      catalogPrice: normalizeCatalogPrice(item.name, item.catalogPrice)
    }));
    const current = this.getModels(category, brandId, seriesId);
    if (sameCatalogRows(current, normalizedItems, [
      'id', 'year', 'name', 'minRegistrationYear', 'maxRegistrationYear', 'catalogPrice'
    ])) {
      this.touch(`models:${category}:${brandId}:${seriesId}`);
      return false;
    }
    const insert = this.db.prepare(`
      INSERT INTO models(category, brand_id, series_id, id, year, name, min_registration_year, max_registration_year, catalog_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      this.db.prepare('DELETE FROM models WHERE category = ? AND brand_id = ? AND series_id = ?').run(category, brandId, seriesId);
      normalizedItems.forEach(item => insert.run(
        category,
        brandId,
        seriesId,
        item.id,
        item.year,
        item.name,
        item.minRegistrationYear,
        item.maxRegistrationYear,
        item.catalogPrice || null
      ));
      this.touch(`models:${category}:${brandId}:${seriesId}`);
    });
    return true;
  }

  getRegions() {
    const provinces = this.db.prepare('SELECT id, name FROM provinces ORDER BY sort_order').all();
    const cities = this.db.prepare('SELECT province_id, id, name FROM cities ORDER BY province_id, sort_order').all();
    const byProvince = new Map(provinces.map(province => [province.id, { ...province, cities: [] }]));
    cities.forEach(city => byProvince.get(city.province_id)?.cities.push({ id: city.id, name: city.name }));
    return [...byProvince.values()];
  }

  replaceRegions(provinces, updatedAt = Date.now()) {
    const insertProvince = this.db.prepare('INSERT INTO provinces(id, name, sort_order) VALUES (?, ?, ?)');
    const insertCity = this.db.prepare('INSERT INTO cities(province_id, id, name, sort_order) VALUES (?, ?, ?, ?)');
    this.transaction(() => {
      this.db.exec('DELETE FROM cities; DELETE FROM provinces;');
      provinces.forEach((province, provinceIndex) => {
        insertProvince.run(province.id, province.name, provinceIndex);
        province.cities.forEach((city, cityIndex) => insertCity.run(province.id, city.id, city.name, cityIndex));
      });
      this.touch('regions', updatedAt);
    });
  }

  getQuote(key) {
    const row = this.db.prepare('SELECT payload FROM quotes WHERE cache_key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch { return null; }
  }

  getLatestQuoteForModel(modelId) {
    const row = this.db.prepare(`
      SELECT cache_key, payload FROM quotes
      WHERE cache_key LIKE ?
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get(`%:%:${modelId}:%`);
    if (!row) return null;
    try { return { key: row.cache_key, quote: JSON.parse(row.payload) }; } catch { return null; }
  }

  saveQuote(key, quote) {
    this.db.prepare(`
      INSERT INTO quotes(cache_key, payload, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
    `).run(key, JSON.stringify(quote), quote.fetchedAt);
  }

  migrateQuotes(quotes) {
    Object.entries(quotes || {}).forEach(([key, quote]) => {
      if (quote?.fetchedAt && !this.getQuote(key)) this.saveQuote(key, quote);
    });
  }

  getVehiclePhoto(imageUrl) {
    const row = this.db.prepare('SELECT image_data FROM vehicle_photos WHERE image_url = ?').get(imageUrl);
    return row ? { imageUrl, imageData: row.image_data } : null;
  }

  saveVehiclePhoto(photo) {
    this.db.prepare(`
      INSERT INTO vehicle_photos(image_url, image_data) VALUES (?, ?)
      ON CONFLICT(image_url) DO UPDATE SET image_data = excluded.image_data
    `).run(photo.imageUrl, photo.imageData);
  }

  updateQuotePhoto(key, previousImageUrl, photo) {
    const quote = this.getQuote(key);
    if (!quote || quote.vehicle?.imageUrl !== previousImageUrl) return;
    quote.vehicle = { ...quote.vehicle, ...photo };
    this.db.prepare('UPDATE quotes SET payload = ? WHERE cache_key = ?').run(JSON.stringify(quote), key);
  }
}

module.exports = { DataStore };
