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
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS shared_vehicle_photo_links (
        category TEXT NOT NULL,
        brand_id TEXT NOT NULL,
        series_id TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(category,brand_id,series_id,model_id,image_url)
      );
      CREATE TABLE IF NOT EXISTS live_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        user_name TEXT NOT NULL,
        comment_text TEXT NOT NULL,
        avatar_url TEXT NOT NULL DEFAULT '',
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_series_parent ON series(category, brand_id);
      CREATE INDEX IF NOT EXISTS idx_models_parent ON models(category, brand_id, series_id);
      CREATE INDEX IF NOT EXISTS idx_cities_parent ON cities(province_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_live_comments_received_at ON live_comments(received_at);
      CREATE TABLE IF NOT EXISTS live_match_failures (
        comment_id INTEGER PRIMARY KEY REFERENCES live_comments(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_live_comments_room_received_at ON live_comments(room, received_at);
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

  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    try { return row ? JSON.parse(row.value) : fallback; } catch { return fallback; }
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO app_settings(key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, JSON.stringify(value));
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

  mergeCatalogFrom(seedFile) {
    const source = new DatabaseSync(seedFile, { readOnly: true });
    try {
      const sourceCounts = {
        brands: source.prepare('SELECT COUNT(*) AS count FROM brands').get().count,
        series: source.prepare('SELECT COUNT(*) AS count FROM series').get().count,
        models: source.prepare('SELECT COUNT(*) AS count FROM models').get().count
      };
      const localCounts = {
        brands: this.db.prepare('SELECT COUNT(*) AS count FROM brands').get().count,
        series: this.db.prepare('SELECT COUNT(*) AS count FROM series').get().count,
        models: this.db.prepare('SELECT COUNT(*) AS count FROM models').get().count
      };
      if (Object.keys(sourceCounts).every(table => localCounts[table] >= sourceCounts[table])) {
        return { changed: false, inserted: { brands: 0, series: 0, models: 0 } };
      }

      const insertBrand = this.db.prepare(`
        INSERT INTO brands(category, id, name, initial) VALUES (?, ?, ?, ?)
        ON CONFLICT(category, id) DO NOTHING
      `);
      const insertSeries = this.db.prepare(`
        INSERT INTO series(category, brand_id, id, name) VALUES (?, ?, ?, ?)
        ON CONFLICT(category, brand_id, id) DO NOTHING
      `);
      const insertModel = this.db.prepare(`
        INSERT INTO models(category, brand_id, series_id, id, year, name,
          min_registration_year, max_registration_year, catalog_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(category, brand_id, series_id, id) DO NOTHING
      `);
      const inserted = { brands: 0, series: 0, models: 0 };
      this.transaction(() => {
        for (const row of source.prepare('SELECT category, id, name, initial FROM brands').iterate()) {
          const result = insertBrand.run(row.category, row.id, row.name, row.initial);
          inserted.brands += Number(result.changes || 0);
        }
        for (const row of source.prepare('SELECT category, brand_id, id, name FROM series').iterate()) {
          const result = insertSeries.run(row.category, row.brand_id, row.id, row.name);
          inserted.series += Number(result.changes || 0);
        }
        for (const row of source.prepare(`
          SELECT category, brand_id, series_id, id, year, name,
                 min_registration_year, max_registration_year, catalog_price
          FROM models
        `).iterate()) {
          const result = insertModel.run(
            row.category, row.brand_id, row.series_id, row.id, row.year, row.name,
            row.min_registration_year, row.max_registration_year, row.catalog_price
          );
          inserted.models += Number(result.changes || 0);
        }
      });
      return { changed: true, inserted };
    } finally {
      source.close();
    }
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
      WHERE cache_key LIKE ? AND cache_key NOT LIKE 'guazi:%'
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get(`%:%:${modelId}:%`);
    if (!row) return null;
    try { return { key: row.cache_key, quote: JSON.parse(row.payload) }; } catch { return null; }
  }

  saveQuote(key, quote) {
    let saved=quote;
    if(/^https:\/\//i.test(quote?.vehicle?.imageUrl||'')&&/^data:image\//.test(quote.vehicle.imageData||'')){
      this.saveVehiclePhoto(quote.vehicle);
      // Prices keep a reference. The image bytes live once in the common
      // photo table, not once for every city/year/odometer quote condition.
      saved={...quote,vehicle:{...quote.vehicle,imageData:''}};
    }
    this.db.prepare(`
      INSERT INTO quotes(cache_key, payload, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
    `).run(key, JSON.stringify(saved), quote.fetchedAt);
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
      WHERE vehicle_photos.image_data <> excluded.image_data
    `).run(photo.imageUrl, photo.imageData);
  }

  linkSharedVehiclePhoto(model, photo, at = Date.now()) {
    if (!model?.category || !model.brandId || !model.seriesId || !photo?.imageUrl
        || !/^https:\/\//i.test(photo.imageUrl)) return;
    if (photo.imageData) this.saveVehiclePhoto(photo);
    this.db.prepare(`INSERT INTO shared_vehicle_photo_links VALUES (?,?,?,?,?,?)
      ON CONFLICT(category,brand_id,series_id,model_id,image_url)
      DO UPDATE SET updated_at=MAX(updated_at,excluded.updated_at)`)
      .run(model.category,String(model.brandId),String(model.seriesId),String(model.id||''),photo.imageUrl,at);
  }

  getSharedVehiclePhoto(model) {
    if (!model?.category || !model.brandId || !model.seriesId) return null;
    const row=this.db.prepare(`SELECT p.image_url imageUrl,p.image_data imageData
      FROM shared_vehicle_photo_links l JOIN vehicle_photos p ON p.image_url=l.image_url
      WHERE l.category=? AND l.brand_id=? AND l.series_id=? AND p.image_data LIKE 'data:image/%;base64,%'
      ORDER BY (l.model_id=?) DESC,l.updated_at DESC LIMIT 1`)
      .get(model.category,String(model.brandId),String(model.seriesId),String(model.id||''));
    return row?{...row}:null;
  }

  saveLiveComment(comment) {
    const result = this.db.prepare(`
      INSERT INTO live_comments(room, user_id, user_name, comment_text, avatar_url, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(comment.room || ''),
      String(comment.userId || ''),
      String(comment.name || '直播观众'),
      String(comment.text || ''),
      String(comment.avatarUrl || ''),
      Number(comment.receivedAt) || Date.now()
    );
    return Number(result.lastInsertRowid);
  }

  listLiveComments(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.db.prepare(`
      SELECT id, room, user_id AS userId, user_name AS name,
             comment_text AS text, avatar_url AS avatarUrl, received_at AS receivedAt
      FROM live_comments
      ORDER BY received_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit);
  }

  recordMatchFailure(id, code, reason) {
    return this.db.prepare('INSERT INTO live_match_failures(comment_id,code,reason) VALUES (?,?,?) ON CONFLICT(comment_id) DO NOTHING')
      .run(id,code,reason).changes > 0;
  }

  matchFailureStats() {
    return this.db.prepare('SELECT count(*) total, coalesce(max(comment_id),0) lastId FROM live_match_failures').get();
  }

  listMatchFailures(before = 0) {
    const cursor=Number.isSafeInteger(before) && before>0 ? before : Number.MAX_SAFE_INTEGER;
    const rows=this.db.prepare(DataStore.failureSelect+' WHERE f.comment_id < ? ORDER BY f.comment_id DESC LIMIT 31').all(cursor);
    const more=rows.length>30;
    if(more)rows.pop();
    return {rows,more,total:this.matchFailureStats().total};
  }

  clearMatchFailures(through) {
    return this.db.prepare('DELETE FROM live_match_failures WHERE comment_id <= ?').run(through).changes;
  }

  updateQuotePhoto(key, previousImageUrl, photo) {
    const quote = this.getQuote(key);
    if (!quote || quote.vehicle?.imageUrl !== previousImageUrl) return;
    quote.vehicle = { ...quote.vehicle, ...photo };
    this.db.prepare('UPDATE quotes SET payload = ? WHERE cache_key = ?').run(JSON.stringify(quote), key);
  }
}

DataStore.failureSelect = `SELECT f.comment_id id,c.received_at receivedAt,c.room,c.user_name name,c.comment_text text,f.code,f.reason
  FROM live_match_failures f JOIN live_comments c ON c.id=f.comment_id`;
module.exports = { DataStore };
