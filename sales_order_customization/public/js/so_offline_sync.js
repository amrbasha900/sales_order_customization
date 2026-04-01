// ═══════════════════════════════════════════════════════
//  OFFLINE ITEMS SYNC (IndexedDB) + LOCAL SEARCH
//  + BARCODE SCANNER + RECENT ITEMS
// ═══════════════════════════════════════════════════════

// -----------------------------
// Offline items (full sync) + local-only search
// -----------------------------

function add_offline_items_sync_button_so(frm) {
    if (frm.doc.docstatus !== 0) return;

    frm.add_custom_button(__('Sync Items Offline'), function () {
        sync_all_items_offline_so(frm, { force: true });
    }, __('Get Items'));

    // Best-effort background sync (won't block the UI)
    sync_all_items_offline_so(frm, { force: false });
}

function compute_initials_so(name) {
    if (!name) return '';
    return String(name)
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map(w => w[0])
        .join('');
}

function tokenize_words_lower_so(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

function ordered_word_prefix_match_so(item_words, tokens) {
    // tokens must match the start of consecutive (in-order) words in item_words
    // Example tokens: ["o","b","e"] matches ["orange","big","egyptian"]
    if (!Array.isArray(item_words) || !item_words.length) return false;
    if (!Array.isArray(tokens) || tokens.length < 2) return false;

    let j = 0;
    for (let i = 0; i < item_words.length && j < tokens.length; i++) {
        if (item_words[i].startsWith(tokens[j])) {
            j++;
        }
    }
    return j === tokens.length;
}

function open_offline_items_db_so() {
    const DB_NAME = 'dr_offline_items';
    const DB_VERSION = 2;
    const STORE = 'items';
    const STORE_UOMS = 'item_uoms';

    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const os = db.createObjectStore(STORE, { keyPath: 'name' }); // Item.name
                os.createIndex('item_code_lower', 'item_code_lower', { unique: false });
                os.createIndex('item_name_lower', 'item_name_lower', { unique: false });
                os.createIndex('barcode_lower', 'barcode_lower', { unique: false });
                os.createIndex('initials', 'initials', { unique: false });
                os.createIndex('modified', 'modified', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_UOMS)) {
                const os2 = db.createObjectStore(STORE_UOMS, { keyPath: 'key' }); // parent|uom
                os2.createIndex('parent', 'parent', { unique: false });
            }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
    });
}

async function offline_items_put_many_so(db, items) {
    if (!db) return;
    await new Promise((resolve) => {
        const tx = db.transaction('items', 'readwrite');
        const os = tx.objectStore('items');
        (items || []).forEach((it) => os.put(it));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

async function offline_uoms_put_many_so(db, rows) {
    if (!db) return;
    await new Promise((resolve) => {
        const tx = db.transaction('item_uoms', 'readwrite');
        const os = tx.objectStore('item_uoms');
        (rows || []).forEach((r) => os.put(r));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

async function offline_uoms_get_for_item_so(item_code) {
    const db = await open_offline_items_db_so();
    if (!db) return [];
    const parent = String(item_code || '').trim();
    if (!parent) return [];

    return await new Promise((resolve) => {
        const tx = db.transaction('item_uoms', 'readonly');
        const os = tx.objectStore('item_uoms');
        const idx = os.index('parent');
        const req = idx.getAll(parent);
        req.onsuccess = () => {
            const rows = req.result || [];
            resolve(rows.map(r => r.uom).filter(Boolean));
        };
        req.onerror = () => resolve([]);
    });
}

async function offline_items_load_all_so(db) {
    if (!db) return [];
    return await new Promise((resolve) => {
        const tx = db.transaction('items', 'readonly');
        const os = tx.objectStore('items');
        const req = os.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

let DR_OFFLINE_ITEMS = {
    syncing: false,
    synced: false,
    loaded: false,
    items: [] // in-memory list for fastest search
};

async function sync_all_items_offline_so(frm, { force }) {
    if (DR_OFFLINE_ITEMS.syncing) return;

    const last_sync = parseInt(localStorage.getItem('dr_offline_items_last_sync_ts') || '0', 10);
    const now = Date.now();
    const sync_interval_ms = 6 * 60 * 60 * 1000; // 6 hours

    if (!force && last_sync && (now - last_sync) < sync_interval_ms) {
        DR_OFFLINE_ITEMS.synced = true;
        return;
    }

    const db = await open_offline_items_db_so();
    if (!db) {
        frappe.show_alert({ message: __('IndexedDB not available; offline sync disabled'), indicator: 'orange' }, 6);
        return;
    }

    DR_OFFLINE_ITEMS.syncing = true;
    DR_OFFLINE_ITEMS.synced = false;
    DR_OFFLINE_ITEMS.loaded = false;
    DR_OFFLINE_ITEMS.items = [];

    frappe.show_alert({ message: __('Syncing all items for offline search...'), indicator: 'blue' }, 6);

    let after_modified = null;
    let after_name = null;
    let total = 0;

    while (true) {
        // eslint-disable-next-line no-await-in-loop
        const r = await new Promise((resolve) => {
            frappe.call({
                method: 'dr.api.item_search.sync_items_minimal',
                args: {
                    after_modified: after_modified,
                    after_name: after_name,
                    limit: 2000
                },
                callback: function (res) { resolve(res); },
                error: function (err) { resolve({ error: err }); }
            });
        });

        if (r && r.error) {
            frappe.show_alert({ message: __('Offline sync failed (network/server). Try again.'), indicator: 'red' }, 6);
            break;
        }

        const payload = r && r.message;
        const batch = (payload && payload.items) || [];
        if (!batch.length) break;

        const to_store = batch.map((row) => {
            const code = row.item_code || row.name || '';
            const name = row.item_name || '';
            const barcode = row.barcode || '';
            const name_words = tokenize_words_lower_so(name);
            return {
                name: row.name,
                item_code: code,
                item_name: name,
                stock_uom: row.stock_uom || '',
                barcode: barcode,
                modified: row.modified,
                item_code_lower: String(code).toLowerCase(),
                item_name_lower: String(name).toLowerCase(),
                barcode_lower: String(barcode).toLowerCase(),
                item_name_words: name_words,
                initials: compute_initials_so(name)
            };
        });

        // eslint-disable-next-line no-await-in-loop
        await offline_items_put_many_so(db, to_store);
        total += to_store.length;

        frappe.show_alert({ message: __('Synced {0} items...', [total]), indicator: 'blue' }, 2);

        if (!payload.has_more) break;
        after_modified = payload.next_after_modified;
        after_name = payload.next_after_name;
    }

    localStorage.setItem('dr_offline_items_last_sync_ts', String(Date.now()));
    DR_OFFLINE_ITEMS.syncing = false;
    DR_OFFLINE_ITEMS.synced = true;

    frappe.show_alert({ message: __('Offline items sync complete ({0} items)', [total]), indicator: 'green' }, 6);

    // Sync UOMs for offline UOM selection/autocomplete
    let u_after_parent = null;
    let u_after_uom = null;
    let u_total = 0;

    frappe.show_alert({ message: __('Syncing item UOMs...'), indicator: 'blue' }, 4);
    while (true) {
        // eslint-disable-next-line no-await-in-loop
        const r2 = await new Promise((resolve) => {
            frappe.call({
                method: 'dr.api.item_search.sync_item_uoms',
                args: {
                    after_parent: u_after_parent,
                    after_uom: u_after_uom,
                    limit: 8000
                },
                callback: function (res) { resolve(res); },
                error: function (err) { resolve({ error: err }); }
            });
        });

        if (r2 && r2.error) {
            frappe.show_alert({ message: __('UOM sync failed (network/server).'), indicator: 'orange' }, 5);
            break;
        }

        const payload2 = r2 && r2.message;
        const batch2 = (payload2 && payload2.rows) || [];
        if (!batch2.length) break;

        const to_store2 = batch2.map((row) => ({
            key: `${row.parent}|${row.uom}`,
            parent: row.parent,
            uom: row.uom,
            conversion_factor: row.conversion_factor
        }));

        // eslint-disable-next-line no-await-in-loop
        await offline_uoms_put_many_so(db, to_store2);
        u_total += to_store2.length;
        frappe.show_alert({ message: __('Synced {0} UOM rows...', [u_total]), indicator: 'blue' }, 2);

        if (!payload2.has_more) break;
        u_after_parent = payload2.next_after_parent;
        u_after_uom = payload2.next_after_uom;
    }

    frappe.show_alert({ message: __('Offline sync ready (items + UOMs)'), indicator: 'green' }, 4);
}

async function ensure_offline_items_loaded_so() {
    if (DR_OFFLINE_ITEMS.loaded) return true;
    const db = await open_offline_items_db_so();
    if (!db) return false;
    const all = await offline_items_load_all_so(db);
    DR_OFFLINE_ITEMS.items = all || [];
    DR_OFFLINE_ITEMS.loaded = true;
    DR_OFFLINE_ITEMS.synced = true;
    return true;
}

function offline_find_by_item_code_exact_so(code) {
    const q = String(code || '').trim().toLowerCase();
    if (!q) return null;
    for (let i = 0; i < DR_OFFLINE_ITEMS.items.length; i++) {
        const it = DR_OFFLINE_ITEMS.items[i];
        if ((it.item_code_lower || '') === q) return it;
    }
    return null;
}

function offline_find_by_barcode_exact_so(barcode) {
    const q = String(barcode || '').trim().toLowerCase();
    if (!q) return null;
    for (let i = 0; i < DR_OFFLINE_ITEMS.items.length; i++) {
        const it = DR_OFFLINE_ITEMS.items[i];
        if ((it.barcode_lower || '') === q) return it;
    }
    return null;
}

function search_items_so(frm, search_text, callback) {
    (async function () {
        const q = String(search_text || '').trim().toLowerCase();
        if (!q || q.length < 2) {
            callback([]);
            return;
        }

        const ok = await ensure_offline_items_loaded_so();
        if (!ok || !DR_OFFLINE_ITEMS.items.length) {
            frappe.show_alert({ message: __('Offline items not synced yet. Click "Sync Items Offline".'), indicator: 'orange' }, 4);
            callback([]);
            return;
        }

        const tokens = q.split(/\s+/).filter(Boolean);
        const is_multi_token = tokens.length >= 2;
        const are_short_tokens = is_multi_token && tokens.every(t => t.length <= 12);

        const exact_code = [];
        const barcode_exact = [];
        const code_starts = [];
        const name_starts = [];
        const ordered_prefix = [];
        const contains = [];

        for (let i = 0; i < DR_OFFLINE_ITEMS.items.length; i++) {
            const it = DR_OFFLINE_ITEMS.items[i];
            const code = it.item_code_lower || '';
            const name = it.item_name_lower || '';
            const barcode = it.barcode_lower || '';
            const words = Array.isArray(it.item_name_words) ? it.item_name_words : tokenize_words_lower_so(it.item_name_lower || '');

            let matched = false;

            if (code === q) {
                matched = true;
                exact_code.push(it);
            } else if (barcode && barcode === q) {
                matched = true;
                barcode_exact.push(it);
            } else if (code.startsWith(q)) {
                matched = true;
                code_starts.push(it);
            } else if (name.startsWith(q)) {
                matched = true;
                name_starts.push(it);
            } else if (are_short_tokens && ordered_word_prefix_match_so(words, tokens)) {
                // Multi-word: each token matches start of a later word (in order)
                matched = true;
                ordered_prefix.push(it);
            } else if (code.includes(q) || name.includes(q) || (barcode && barcode.includes(q))) {
                matched = true;
                contains.push(it);
            } else if (are_short_tokens && is_multi_token) {
                // Multi-token partial match: all tokens appear somewhere (any order)
                const all_match = tokens.every(t =>
                    code.includes(t) || name.includes(t) || (barcode && barcode.includes(t))
                );
                if (all_match) {
                    matched = true;
                    contains.push(it);
                }
            }

            if (matched) {
                const total = exact_code.length + barcode_exact.length + code_starts.length + name_starts.length + ordered_prefix.length + contains.length;
                if (total >= 50) break;
            }
        }

        const results = []
            .concat(exact_code, barcode_exact, code_starts, name_starts, ordered_prefix, contains)
            .slice(0, 50)
            .map((it) => ({
                item_code: it.item_code,
                item_name: it.item_name,
                stock_uom: it.stock_uom,
                barcode: it.barcode || ''
            }));

        callback(results);
    })();
}

// ═══════════════════════════════════════════════════════
//  BARCODE SCANNER
// ═══════════════════════════════════════════════════════

function setup_barcode_scanner_so(frm) {
    let barcode_buffer = '';
    let barcode_timeout = null;
    let last_keypress_time = 0;

    $(document).on('keypress', function (e) {
        // Only process if on the form
        if (!$(document.activeElement).closest('.form-page').length &&
            document.activeElement.id !== 'quick_item_search') {
            return;
        }

        const current_time = new Date().getTime();

        // If more than 100ms since last keypress, reset buffer
        if (current_time - last_keypress_time > 100) {
            barcode_buffer = '';
        }

        last_keypress_time = current_time;
        clearTimeout(barcode_timeout);

        if (e.which === 13) { // Enter key
            if (barcode_buffer.length > 3) {
                // Process as barcode
                process_barcode_so(frm, barcode_buffer);
                barcode_buffer = '';
                e.preventDefault();
            }
        } else {
            // Add character to buffer
            barcode_buffer += String.fromCharCode(e.which);
        }

        // Auto-clear buffer after 200ms
        barcode_timeout = setTimeout(function () {
            barcode_buffer = '';
        }, 200);
    });
}

function process_barcode_so(frm, barcode) {
    (async function () {
        const ok = await ensure_offline_items_loaded_so();
        if (!ok || !DR_OFFLINE_ITEMS.items.length) {
            frappe.show_alert({ message: __('Offline items not synced yet. Click "Sync Items Offline".'), indicator: 'orange' }, 4);
            return;
        }

        const found = offline_find_by_barcode_exact_so(barcode);
        if (found) {
            add_item_to_table_so(frm, { item_code: found.item_code, item_name: found.item_name, barcode: found.barcode });
        } else {
            frappe.show_alert({
                message: __('Item not found for barcode: {0}', [barcode]),
                indicator: 'orange'
            }, 5);
        }
    })();
}

// ═══════════════════════════════════════════════════════
//  RECENT ITEMS
// ═══════════════════════════════════════════════════════

function add_recent_items_button_so(frm) {
    if (frm.doc.docstatus === 0) {
        frm.add_custom_button(__('Recent Items'), function () {
            show_recent_items_dialog_so(frm);
        }, __('Get Items'));
    }
}

function show_recent_items_dialog_so(frm) {
    frappe.call({
        method: 'dr.api.item_search.get_recent_items',
        args: {
            customer: frm.doc.customer,
            limit: 20
        },
        callback: function (r) {
            if (r.message && r.message.length > 0) {
                let html = '<div style="max-height: 400px; overflow-y: auto;">';

                r.message.forEach(item => {
                    html += `
                        <div style="padding: 10px; border-bottom: 1px solid #f0f0f0; cursor: pointer;" 
                             onclick="add_recent_item('${item.item_code}')">
                            <div style="font-weight: 600;">${item.item_code} - ${item.item_name}</div>
                            <div style="font-size: 12px; color: #888;">
                                Sold ${item.total_qty} times | Last: ${item.last_sold}
                            </div>
                        </div>
                    `;
                });

                html += '</div>';

                frappe.msgprint({
                    title: __('Recent Items'),
                    message: html,
                    wide: true
                });
            } else {
                frappe.msgprint(__('No recent items found'));
            }
        }
    });
}

// Make function global
window.add_recent_item = function (item_code) {
    const frm = cur_frm;
    (async function () {
        const ok = await ensure_offline_items_loaded_so();
        if (!ok || !DR_OFFLINE_ITEMS.items.length) {
            frappe.show_alert({ message: __('Offline items not synced yet. Click "Sync Items Offline".'), indicator: 'orange' }, 4);
            return;
        }

        const found = offline_find_by_item_code_exact_so(item_code);
        if (found) {
            add_item_to_table_so(frm, { item_code: found.item_code, item_name: found.item_name, barcode: found.barcode });
            cur_dialog.hide();
        } else {
            frappe.show_alert({ message: __('Item not found in offline data: {0}', [item_code]), indicator: 'orange' }, 4);
        }
    })();
};
