// ═══════════════════════════════════════════════════════
//  QUICK ITEM SEARCH + AUTOCOMPLETE + ADD-TO-TABLE
// ═══════════════════════════════════════════════════════

function remove_rows_without_item_code_so(frm) {
    if (!frm || !frm.doc || !Array.isArray(frm.doc.items) || !frm.doc.items.length) return;
    const rows = (frm.doc.items || []).slice();
    let removed = false;
    rows.forEach((row) => {
        if (row && !row.item_code) {
            frappe.model.clear_doc(row.doctype, row.name);
            removed = true;
        }
    });
    if (removed) {
        frm.refresh_field('items');
    }
}

function toggle_quick_add_visibility_so(frm) {
    if (!frm || !frm.custom_item_search) return;
    const has_customer = !!(frm.doc && frm.doc.customer);
    const container = frm.custom_item_search;
    const body = container.find('.quick-item-search-body');
    const empty = container.find('.quick-item-search-empty');
    if (has_customer) {
        body.show();
        empty.hide();
        setTimeout(() => {
            const input = document.getElementById('quick_item_search');
            if (input) input.focus();
        }, 200);
    } else {
        // Hide the whole input area until customer is selected
        body.hide();
        empty.show();
    }
}

function show_item_details_popup_so(frm, item) {
    if (!item || !item.item_code) return;
    if (!frm.doc.customer) {
        frappe.msgprint(__('Please select Customer first.'));
        return;
    }
    const wh = frm.doc.set_warehouse || null;

    const d = new frappe.ui.Dialog({
        title: __('Item Details'),
        size: 'large',
        fields: [{ fieldtype: 'HTML', fieldname: 'content' }]
    });
    d.fields_dict.content.$wrapper.html(`
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <div><b>${__('Item')}:</b> ${frappe.utils.escape_html(item.item_code)} - ${frappe.utils.escape_html(item.item_name || '')}</div>
            <div class="text-muted">${__('Loading...')}</div>
        </div>
        <div id="dr_item_popup_meta" style="margin-top:10px;"></div>
        <div id="dr_item_popup_table_wrap" style="margin-top:10px;"></div>
        <div style="display:flex; justify-content:flex-end; margin-top:10px;">
            <button class="btn btn-sm btn-secondary" id="dr_item_popup_load_more" style="display:none;">${__('Load more')}</button>
        </div>
    `);
    d.show();

    const $wrap = d.fields_dict.content.$wrapper;
    const $meta = $wrap.find('#dr_item_popup_meta');
    const $table_wrap = $wrap.find('#dr_item_popup_table_wrap');
    const $load_more = $wrap.find('#dr_item_popup_load_more');

    let next_offset = 0;
    let has_more = false;

    function render_meta_so(data) {
        const warehouse_used = data.warehouse || '';
        const valuation_rate = data.valuation_rate || 0;
        const incoming_rate = data.incoming_rate;
        const src_type = data.incoming_rate_source_voucher_type || '';
        const src_no = data.incoming_rate_source_voucher_no || '';

        const incoming_html = (incoming_rate !== null && incoming_rate !== undefined) ? `
            <div style="margin-top:10px; padding:10px; background:#fff7e6; border:1px solid #ffe1b3; border-radius:6px;">
                <b>${__('Incoming Rate')}:</b> ${format_number(incoming_rate || 0, null, 2)}
                ${src_type && src_no ? `<div class="text-muted small" style="margin-top:4px;">${__('Source')}: ${frappe.utils.escape_html(src_type)} ${frappe.utils.escape_html(src_no)}</div>` : ''}
            </div>
        ` : `
            <div class="text-muted small" style="margin-top:10px;">${__('Incoming Rate')}: ${__('(not available until stock entry is posted)')}</div>
        `;

        $meta.html(`
            <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
                <div><b>${__('Warehouse')}:</b> ${frappe.utils.escape_html(warehouse_used || __('(not found)'))}</div>
                <div><b>${__('Valuation Rate')}:</b> ${format_number(valuation_rate || 0, null, 2)}</div>
            </div>
            ${incoming_html}
        `);
    }

    function ensure_table_so() {
        if ($table_wrap.find('table').length) return;
        $table_wrap.html(`
            <table class="table table-bordered" style="margin-top:10px;">
                <thead>
                    <tr>
                        <th>${__('Date')}</th>
                        <th>${__('Rate')}</th>
                        <th>${__('Qty')}</th>
                        <th>${__('UOM')}</th>
                        <th>${__('Incoming Rate')}</th>
                    </tr>
                </thead>
                <tbody id="dr_item_popup_tbody"></tbody>
            </table>
        `);
    }

    function append_rows_so(rows) {
        if (!rows || !rows.length) return;
        ensure_table_so();
        const $tbody = $table_wrap.find('#dr_item_popup_tbody');
        $tbody.append(rows.map(x => `
            <tr>
                <td>${frappe.datetime.str_to_user(x.posting_date)}</td>
                <td>${format_number(x.rate || 0, null, 2)} ${frappe.utils.escape_html(x.currency || '')}</td>
                <td>${format_number(x.qty || 0, null, 2)}</td>
                <td>${frappe.utils.escape_html(x.uom || '')}</td>
                <td>${(x.incoming_rate !== null && x.incoming_rate !== undefined) ? format_number(x.incoming_rate || 0, null, 2) : '-'}</td>
            </tr>
        `).join(''));
    }

    function load_page_so() {
        $load_more.prop('disabled', true).text(__('Loading...')).show();
        frappe.call({
            method: 'dr.api.item_search.get_customer_item_rate_and_valuation_page',
            args: {
                customer: frm.doc.customer,
                item_code: item.item_code,
                warehouse: wh,
                invoice_name: frm.doc.name || null,
                update_stock: frm.doc.update_stock ? 1 : 0,
                limit: 5,
                offset: next_offset
            },
            callback: function (r) {
                const data = r.message || {};
                render_meta_so(data);
                const rows = data.history || [];
                if (next_offset === 0 && (!rows || !rows.length)) {
                    $table_wrap.html(`<div class="text-muted" style="margin-top:10px;">${__('No previous sales for this customer/item.')}</div>`);
                } else {
                    append_rows_so(rows);
                }
                has_more = !!data.has_more;
                next_offset = data.next_offset || (next_offset + rows.length);
                if (has_more) {
                    $load_more.prop('disabled', false).text(__('Load more')).show();
                } else {
                    $load_more.hide();
                }
            }
        });
    }

    $load_more.on('click', function () {
        load_page_so();
    });

    load_page_so();
}

function attach_items_grid_details_buttons_so(frm) {
    const grid = frm.fields_dict.items && frm.fields_dict.items.grid;
    if (!grid || !grid.grid_rows) return;

    // Re-attach on each row render (grid re-renders often)
    if (!frm.wrapper._dr_grid_row_render_bound) {
        frm.wrapper._dr_grid_row_render_bound = true;
        $(frm.wrapper).on('grid-row-render', function (_e, grid_row) {
            // Only for this form's items grid
            if (!grid_row || !grid_row.doc || !grid_row.wrapper) return;
            if (grid_row.doc.parentfield !== 'items' || grid_row.doc.parenttype !== 'Sales Order') return;
            // inject for this row
            const gr = grid_row;
            gr.wrapper.find('.dr-item-details-btn').remove();
            if (!gr.doc.item_code) return;
            // Put button in the last "actions" column (same area as row edit icon)
            const action_col = gr.wrapper.find('.btn-open-row').closest('.col');
            const target = (action_col && action_col.length) ? action_col : gr.wrapper.find('.data-row .col:last');
            if (!target || !target.length) return;
            // Make action column align icons in one line
            target.css({ display: 'flex', gap: '6px', justifyContent: 'center', alignItems: 'center' });
            target.append(`
                <div class="btn-open-row dr-item-details-btn" data-docname="${frappe.utils.escape_html(gr.doc.name)}"
                     title="${__('Details')}" style="display:inline-flex;" data-toggle="tooltip" data-placement="right">
                    <a>${frappe.utils.icon("link-url", "sm")}</a>
                </div>
            `);
        });
    }

    // Bind click once (event delegation)
    if (!grid.wrapper.data('dr_details_bound')) {
        grid.wrapper.data('dr_details_bound', true);
        grid.wrapper.on('click', '.dr-item-details-btn', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const docname = $(this).attr('data-docname');
            const row = (frm.doc.items || []).find(r => r && r.name === docname);
            if (row && row.item_code) {
                show_item_details_popup_so(frm, { item_code: row.item_code, item_name: row.item_name });
            }
        });
    }

    // Render/refresh buttons
    grid.grid_rows.forEach((gr) => {
        if (!gr || !gr.doc || !gr.wrapper) return;
        // remove old
        gr.wrapper.find('.dr-item-details-btn').remove();
        if (!gr.doc.item_code) return;

        const action_col = gr.wrapper.find('.btn-open-row').closest('.col');
        const target = (action_col && action_col.length) ? action_col : gr.wrapper.find('.data-row .col:last');
        if (!target || !target.length) return;
        target.css({ display: 'flex', gap: '6px', justifyContent: 'center', alignItems: 'center' });
        target.append(`
            <div class="btn-open-row dr-item-details-btn" data-docname="${frappe.utils.escape_html(gr.doc.name)}"
                 title="${__('Details')}" style="display:inline-flex;" data-toggle="tooltip" data-placement="right">
                <a>${frappe.utils.icon("link-url", "sm")}</a>
            </div>
        `);
    });
}

function calculate_item_values_so(frm, cdt, cdn) {
    let item = frappe.get_doc(cdt, cdn);
    frappe.model.set_value(cdt, cdn, 'amount', item.qty * item.rate);
}

function is_empty_item_row_so(row) {
    if (!row) return true;
    const has_text = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const has_num = (v) => v !== undefined && v !== null && Number(v) !== 0;

    return !(
        has_text(row.item_code) ||
        has_text(row.item_name) ||
        has_text(row.description) ||
        has_text(row.uom) ||
        has_text(row.stock_uom) ||
        has_text(row.warehouse) ||
        has_num(row.qty) ||
        has_num(row.rate) ||
        has_num(row.amount)
    );
}

function cleanup_default_empty_item_rows_so(frm) {
    if (!frm || !frm.doc || !Array.isArray(frm.doc.items) || !frm.doc.items.length) return;

    // Only remove if there are NO real items (so we don't delete a partially-edited row in an existing invoice).
    const has_real_item = frm.doc.items.some(r => r && r.item_code);
    if (has_real_item) return;

    const rows = (frm.doc.items || []).slice();
    let removed = false;
    rows.forEach((row) => {
        if (is_empty_item_row_so(row)) {
            frappe.model.clear_doc(row.doctype, row.name);
            removed = true;
        }
    });
    if (removed) {
        frm.refresh_field('items');
    }
}

function cleanup_empty_item_rows_so(frm) {
    if (!frm || !frm.doc || !Array.isArray(frm.doc.items) || !frm.doc.items.length) return;
    const rows = (frm.doc.items || []).slice();
    let removed = false;
    rows.forEach((row) => {
        if (is_empty_item_row_so(row)) {
            frappe.model.clear_doc(row.doctype, row.name);
            removed = true;
        }
    });
    if (removed) {
        frm.refresh_field('items');
    }
}

function move_item_row_to_top_so(frm, row) {
    if (!frm || !frm.doc || !Array.isArray(frm.doc.items) || !row) return;
    // Put before first row, then re-number
    row.idx = 0.9;
    frm.doc.items.sort((a, b) => (a.idx || 0) - (b.idx || 0));
    frm.doc.items.forEach((d, i) => { d.idx = i + 1; });
}

function add_quick_item_search_so(frm) {
    // Remove existing search if present
    if (frm.custom_item_search) {
        frm.custom_item_search.remove();
    }

    // Create search container with styling
    const search_html = `
        <div class="quick-item-search" style="margin: 15px 0; padding: 15px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e3e8ef;">
            <div class="quick-item-search-empty" style="display:none; padding: 10px 0;">
                <div class="text-muted" style="display:flex; align-items:center; gap:8px;">
                    <span>${frappe.utils.icon("small-add", "sm")}</span>
                    <span>${__('Select Customer to enable quick item add')}</span>
                </div>
            </div>
            <div class="quick-item-search-body">
            <div class="form-group" style="margin-bottom: 0;">
                    <div class="control-input-wrapper">
                        <div style="display:flex; gap:8px; align-items:center;">
                        <div class="control-input" style="position: relative; flex:1;">
                            <span style="position:absolute; z-index:2; pointer-events:none; left:12px; top:50%; transform:translateY(-50%); color:#6c757d;">
                                <svg style="width:16px;height:16px;display:block;" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="11" cy="11" r="8"></circle>
                        <path d="m21 21-4.35-4.35"></path>
                    </svg>
                            </span>
                        <input 
                            type="text" 
                            class="input-with-feedback form-control" 
                            id="quick_item_search"
                                placeholder="Search item / barcode..."
                            autocomplete="off"
                                style="position: relative; z-index: 1; font-size: 14px; padding: 10px 40px 10px 38px; border: 2px solid #d1d8dd; border-radius: 6px; transition: all 0.2s;"
                        >
                        <div id="search_loading" style="
                            position: absolute;
                            right: 12px;
                            top: 50%;
                            transform: translateY(-50%);
                            display: none;
                        ">
                            <svg style="width: 20px; height: 20px; animation: spin 1s linear infinite;" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                            </svg>
                        </div>
                        <div id="search_results" class="search-results-dropdown" style="
                            position: absolute;
                            top: calc(100% + 4px);
                            left: 0;
                            right: 0;
                            background: white;
                            border: 1px solid #d1d8dd;
                            border-radius: 6px;
                            max-height: 450px;
                            overflow-y: auto;
                            display: none;
                            z-index: 1000;
                            box-shadow: 0 8px 16px rgba(0,0,0,0.1);
                        "></div>
                    </div>
                        <button id="quick_add_help_btn" type="button" class="btn btn-sm btn-default" style="
                            height: 40px;
                            padding: 0 10px;
                            border-radius: 8px;
                            white-space: nowrap;
                        ">${__('إرشاد')}</button>
                    </div>

                        <div id="quick_add_controls" style="margin-top: 10px; display: none;">
                            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; width:100%;">
                                <div style="flex: 0 0 calc(40% - 8px); min-width: 260px;">
                                <div class="text-muted small" style="margin-bottom:4px;">Selected</div>
                                <input id="quick_add_selected" class="form-control input-sm" readonly style="height:34px; font-weight:600; background:#fff;">
                </div>
                                <div style="flex: 0 0 calc(15% - 8px); min-width: 120px;">
                                <label class="text-muted small" style="margin-bottom:4px; display:block;">Qty</label>
                                <input id="quick_add_qty" type="number" class="form-control input-sm" value="1" min="0" step="1" style="height:34px;">
                            </div>
                                <div style="flex: 0 0 calc(15% - 8px); min-width: 140px;">
                                <label class="text-muted small" style="margin-bottom:4px; display:block;">UOM</label>
                                <div style="position:relative;">
                                    <input id="quick_add_uom" class="form-control input-sm" placeholder="UOM" style="height:34px;">
                                    <div id="quick_add_uom_results" style="
                                        position: absolute;
                                        top: calc(100% + 4px);
                                        left: 0;
                                        right: 0;
                                        background: white;
                                        border: 1px solid #d1d8dd;
                                        border-radius: 6px;
                                        max-height: 220px;
                                        overflow-y: auto;
                                        display: none;
                                        z-index: 1100;
                                        box-shadow: 0 8px 16px rgba(0,0,0,0.1);
                                    "></div>
                                </div>
                            </div>
                                <div style="flex: 0 0 calc(15% - 8px); min-width: 140px;">
                                <label class="text-muted small" style="margin-bottom:4px; display:block;">Rate</label>
                                <input id="quick_add_rate" type="number" class="form-control input-sm" placeholder="auto" step="0.01" style="height:34px;">
                            </div>
                                <div style="flex: 0 0 calc(15% - 8px); min-width: 140px;">
                                <label class="text-muted small" style="margin-bottom:4px; display:block;">Last Price</label>
                                <input id="quick_add_last_price" class="form-control input-sm" readonly style="height:34px; background:#fff3cd; font-weight:600; color:#856404;" placeholder="-">
                            </div>
                                <div style="flex: 0 0 calc(15% - 8px); min-width: 160px; display:flex; gap:8px; align-items:flex-end; justify-content:flex-end;">
                                    <button id="quick_add_btn" class="btn btn-primary btn-sm" type="button" style="height:34px;">Add</button>
                                    <button id="quick_add_details_btn" class="btn btn-default btn-sm" type="button" style="height:34px; display:none;">Details</button>
                                </div>
                        </div>
                    </div>
                </div>
            </div>
            </div>
        </div>
        <style>
            @keyframes dr-spin { to { transform: rotate(360deg); } }
            .quick-item-search {
                margin: 20px 0;
                padding: 18px;
                background: var(--bg-light-gray, #f8f9fa);
                border-radius: 12px;
                border: 1px solid var(--border-color, #e3e8ef);
                box-shadow: 0 4px 12px rgba(0,0,0,0.03);
                transition: all 0.3s ease;
            }
            #quick_item_search:focus {
                border-color: var(--primary, #2490ef) !important;
                box-shadow: 0 0 0 4px rgba(36, 144, 239, 0.15) !important;
                outline: none;
            }
            .search-results-dropdown {
                box-shadow: 0 12px 24px rgba(0,0,0,0.15);
                border: 1px solid var(--border-color, #d1d8dd);
                backdrop-filter: blur(10px);
                background: rgba(255, 255, 255, 0.98) !important;
            }
            .search-result-item {
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                border-left: 3px solid transparent;
            }
            .search-result-item:hover, .search-result-item.selected {
                background: var(--bg-hover-color, #f0f4ff) !important;
                border-left-color: var(--primary, #2490ef);
                transform: translateX(4px);
            }
            .stock-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 3px 10px;
                border-radius: 20px;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.3px;
            }
            .stock-badge.in-stock { background: #e8f5e9; color: #2e7d32; }
            .stock-badge.out-of-stock { background: #ffebee; color: #c62828; }
            
            .uom-result-item {
                transition: all 0.2s;
                padding: 10px 15px;
            }
            .uom-result-item:hover, .uom-result-item.selected {
                background: #f1f8e9 !important;
                color: #33691e;
            }
        </style>
    `;

    // Add to form before items table
    frm.custom_item_search = $(search_html).insertBefore(frm.fields_dict.items.wrapper);
    toggle_quick_add_visibility_so(frm);

    // Initialize autocomplete functionality
    setup_autocomplete_so(frm);
}

function setup_autocomplete_so(frm) {
    const input = document.getElementById('quick_item_search');
    const results_div = document.getElementById('search_results');
    const loading_icon = document.getElementById('search_loading');
    const controls_div = document.getElementById('quick_add_controls');
    const selected_div = document.getElementById('quick_add_selected');
    const qty_input = document.getElementById('quick_add_qty');
    const uom_input = document.getElementById('quick_add_uom');
    const uom_results = document.getElementById('quick_add_uom_results');
    const rate_input = document.getElementById('quick_add_rate');
    const last_price_input = document.getElementById('quick_add_last_price');
    const add_btn = document.getElementById('quick_add_btn');
    const details_btn = document.getElementById('quick_add_details_btn');
    const help_btn = document.getElementById('quick_add_help_btn');
    let search_timeout = null;
    let selected_index = -1;
    let items_list = [];
    let current_search = '';
    let add_in_progress = false;
    let pending_item = null;
    let uom_options = [];
    let uom_selected_index = -1;

    // Focus input on form load
    setTimeout(() => input.focus(), 500);

    function show_controls_so(show) {
        if (!controls_div) return;
        controls_div.style.display = show ? 'block' : 'none';
    }

    function clear_controls_so() {
        pending_item = null;
        if (selected_div) selected_div.value = '';
        if (qty_input) qty_input.value = '1';
        if (uom_input) uom_input.value = '';
        if (uom_input) {
            uom_input.disabled = false;
            uom_input.readOnly = false;
        }
        if (rate_input) rate_input.value = '';
        if (last_price_input) last_price_input.value = '';
        if (uom_results) uom_results.innerHTML = '';
        if (uom_results) uom_results.style.display = 'none';
        if (details_btn) details_btn.style.display = 'none';
        uom_options = [];
        uom_selected_index = -1;
        show_controls_so(false);
    }

    function fetch_and_display_last_price(item_code, uom) {
        if (!frm.doc.customer || !item_code) {
            if (last_price_input) last_price_input.value = '-';
            return;
        }
        frappe.call({
            method: 'sales_order_customization.api.sales_order_actions.get_last_sales_rate',
            args: {
                customer: frm.doc.customer,
                item_code: item_code,
                uom: uom || ''
            },
            callback: function (r) {
                if (last_price_input) {
                    if (r.message !== undefined && r.message !== null && flt(r.message) > 0) {
                        last_price_input.value = format_number(flt(r.message), null, 2);
                    } else {
                        last_price_input.value = '-';
                    }
                }
            }
        });
    }

    async function populate_uoms_for_item_so(item_code, preferred_uom) {
        const uoms = await offline_uoms_get_for_item_so(item_code);
        const unique = new Set((uoms || []).filter(Boolean));
        if (preferred_uom) unique.add(preferred_uom);
        uom_options = [...unique].slice(0, 200);
        uom_selected_index = -1;

        // If only one UOM exists, lock it (cannot be changed) BUT keep it focusable (Tab)
        if (uom_input) {
            if (uom_options.length === 1) {
                uom_input.value = uom_options[0];
                uom_input.readOnly = true;
                uom_input.disabled = false;
            } else {
                uom_input.readOnly = false;
                uom_input.disabled = false;
            }
        }
    }

    function hide_uom_dropdown_so() {
        if (!uom_results) return;
        uom_results.style.display = 'none';
        uom_selected_index = -1;
    }

    function highlight_uom_selected_so() {
        if (!uom_results) return;
        uom_results.querySelectorAll('.uom-result-item').forEach((el, idx) => {
            if (idx === uom_selected_index) {
                el.classList.add('selected');
                el.style.background = '#e8f5e9';
            } else {
                el.classList.remove('selected');
                el.style.background = 'white';
            }
        });
    }

    function render_uom_dropdown_so(filter_text) {
        if (!uom_results || !uom_input) return;
        if (uom_input.disabled || uom_input.readOnly) {
            hide_uom_dropdown_so();
            return;
        }

        const f = String(filter_text || '').toLowerCase();
        const list = (uom_options || []).filter(u => !f || String(u).toLowerCase().includes(f));
        if (!list.length) {
            uom_results.style.display = 'none';
            return;
        }

        uom_results.innerHTML = list.map((u, idx) => `
            <div class="uom-result-item" data-index="${idx}" style="
                padding: 8px 10px;
                border-bottom: 1px solid #f0f0f0;
                cursor: pointer;
                font-size: 13px;
            ">${frappe.utils.escape_html(String(u))}</div>
        `).join('');

        uom_results.style.display = 'block';
        uom_selected_index = 0;
        highlight_uom_selected_so();

        uom_results.querySelectorAll('.uom-result-item').forEach((el) => {
            el.addEventListener('mouseenter', function () {
                uom_selected_index = parseInt(this.dataset.index);
                highlight_uom_selected_so();
            });
            el.addEventListener('click', function () {
                const idx = parseInt(this.dataset.index);
                const val = list[idx];
                uom_input.value = val;
                hide_uom_dropdown_so();
                // Re-fetch last price for the new UOM
                if (pending_item) fetch_and_display_last_price(pending_item.item_code, val);
                setTimeout(() => rate_input && rate_input.focus(), 10);
            });
        });
    }

    async function prepare_item_for_add_so(item) {
        if (!item || !item.item_code) return;
        pending_item = item;

        // Reset controls for the newly selected item (so rate/uom always refresh)
        if (qty_input) qty_input.value = '1';
        if (uom_input && !uom_input.readOnly) uom_input.value = '';
        // Don't prefetch price in quick add (faster). Rate will be set when adding to the table.
        if (rate_input) rate_input.value = '';

        if (selected_div) {
            selected_div.value = `${item.item_code} - ${item.item_name || ''}`.trim();
        }
        show_controls_so(true);
        // Close item dropdown when an item is selected
        if (results_div) results_div.style.display = 'none';
        if (details_btn) details_btn.style.display = 'inline-block';

        // Populate UOMs offline (if synced)
        await populate_uoms_for_item_so(item.item_code, item.stock_uom);
        // Set default UOM quickly (offline) if empty
        if (uom_input && !uom_input.value && item.stock_uom) {
            uom_input.value = item.stock_uom;
        }

        // Fetch and display last price for the selected item + UOM
        fetch_and_display_last_price(item.item_code, uom_input ? uom_input.value : item.stock_uom);

        // Focus Qty for fast Tab/Enter workflow
        setTimeout(() => qty_input && qty_input.focus(), 20);
        setTimeout(() => qty_input && qty_input.select && qty_input.select(), 30);
    }

    function show_selected_item_details_so() {
        if (!pending_item || !pending_item.item_code) return;
        show_item_details_popup_so(frm, pending_item);
    }

    function commit_pending_add_so() {
        if (!pending_item) return;
        const qty = parseFloat(qty_input?.value || '1') || 1;
        const uom = String(uom_input?.value || '').trim();
        const rate_str = String(rate_input?.value || '').trim();
        const rate = rate_str ? parseFloat(rate_str) : null;
        // Read last price from the search bar (read-only field)
        const lp_str = String(last_price_input?.value || '').trim();
        const last_price = (lp_str && lp_str !== '-') ? parseFloat(lp_str.replace(/,/g, '')) : null;

        add_item_to_table_so(frm, pending_item, { qty, uom: uom || null, rate, last_price: last_price });
        // After commit, reset for next scan
        clear_controls_so();
        input.value = '';
        results_div.style.display = 'none';
        setTimeout(() => input.focus(), 30);
    }

    if (add_btn) {
        add_btn.addEventListener('click', function () {
            commit_pending_add_so();
        });
    }

    if (details_btn) {
        details_btn.addEventListener('click', function () {
            show_selected_item_details_so();
        });
    }

    if (help_btn) {
        help_btn.addEventListener('click', function () {
            frappe.msgprint({
                title: __('إرشادات البحث السريع'),
                message: `
                    <div style="line-height:1.9">
                        <div><b>1)</b> اختر <b>العميل</b> أولاً ليظهر البحث السريع.</div>
                        <div><b>2)</b> اكتب 2+ أحرف ثم <b>Enter</b> لاختيار أول صنف (لن تتم الإضافة بعد).</div>
                        <div><b>3)</b> استخدم <b>Tab</b> للتنقل بين: الكمية → الوحدة → السعر → إضافة → التفاصيل.</div>
                        <div><b>4)</b> اضغط <b>Enter</b> داخل (الكمية/الوحدة/السعر) لإضافة الصنف للجدول.</div>
                        <div><b>5)</b> السعر لا يتم حسابه في الحقل هنا لتسريع الأداء — سيظهر في الجدول بعد الإضافة.</div>
                        <div><b>6)</b> اختصار: داخل (الكمية/الوحدة/السعر) اضغط <b>Alt</b> لفتح نافذة التفاصيل.</div>
                        <div class="text-muted" style="margin-top:8px;">للبحث بدون إنترنت: من (Get Items) اضغط <b>Sync Items Offline</b>.</div>
                    </div>
                `,
                indicator: 'blue'
            });
        });
    }

    [qty_input, uom_input, rate_input].forEach((el) => {
        if (!el) return;
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                // If UOM dropdown is open, let the UOM-specific handler select the value first
                if (uom_results && uom_results.style.display !== 'none' && el === uom_input) {
                    return;
                }
                commit_pending_add_so();
            } else if (e.key === 'Alt') {
                // Shortcut: Alt opens Details popup
                e.preventDefault();
                show_selected_item_details_so();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                clear_controls_so();
                setTimeout(() => input.focus(), 30);
            }
        });
    });

    // Input event - trigger search
    input.addEventListener('input', function (e) {
        const search_text = e.target.value.trim();
        current_search = search_text;

        clearTimeout(search_timeout);

        if (search_text.length < 2) {
            results_div.style.display = 'none';
            loading_icon.style.display = 'none';
            return;
        }

        // Show loading
        loading_icon.style.display = 'block';

        search_timeout = setTimeout(function () {
            search_items_so(frm, search_text, function (items) {
                // Only update if this is still the current search
                if (current_search === search_text) {
                    loading_icon.style.display = 'none';
                    display_results_so(items);
                }
            });
        }, 300); // 300ms debounce
    });

    // Keydown event - handle navigation and selection
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();

            if (add_in_progress) return;

            // Two-step: Enter selects/prepares the item; Enter in qty/uom/rate commits add
            const to_prepare =
                (selected_index >= 0 && items_list[selected_index]) ? items_list[selected_index] :
                    (items_list.length > 0 ? items_list[0] : null);

            if (to_prepare) {
                prepare_item_for_add_so(to_prepare);
                return;
            }

            // No results
            if (input.value.trim()) {
                frappe.show_alert({
                    message: __('No items found. Please refine your search'),
                    indicator: 'orange'
                }, 3);
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            selected_index = Math.min(selected_index + 1, items_list.length - 1);
            highlight_selected_so();
            scroll_to_selected_so();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selected_index = Math.max(selected_index - 1, -1);
            highlight_selected_so();
            scroll_to_selected_so();
        } else if (e.key === 'Escape') {
            results_div.style.display = 'none';
            selected_index = -1;
        } else if (e.key === 'Tab') {
            // Tab selects first item and moves to Qty (closes dropdown)
            if (items_list.length > 0) {
                e.preventDefault();
                const to_prepare = (selected_index >= 0 && items_list[selected_index]) ? items_list[selected_index] : items_list[0];
                prepare_item_for_add_so(to_prepare);
            }
        }
    });

    function display_results_so(items) {
        items_list = items || [];
        selected_index = -1;

        if (!items || items.length === 0) {
            results_div.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #888;">
                    <svg style="width: 48px; height: 48px; margin-bottom: 10px; opacity: 0.5;" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="11" cy="11" r="8"></circle>
                        <path d="m21 21-4.35-4.35"></path>
                    </svg>
                    <div>No items found</div>
                    <div style="font-size: 12px; margin-top: 5px;">Try a different search term</div>
                </div>
            `;
            results_div.style.display = 'block';
            return;
        }

        let html = '';
        items.forEach((item, index) => {
            const has_rate = item.rate !== undefined && item.rate !== null && item.rate !== '';
            const has_stock = item.available_qty !== undefined && item.available_qty !== null && item.available_qty !== '';
            const stock_class = item.stock_status === 'in_stock' ? 'in-stock' : 'out-of-stock';
            const stock_text = has_stock && item.available_qty > 0 ? `${item.available_qty} ${item.stock_uom || ''}` : 'Out of Stock';
            const barcode_text = item.barcode ? String(item.barcode) : '';

            html += `
                <div class="search-result-item" data-index="${index}" style="
                    padding: 12px 15px;
                    border-bottom: 1px solid #f0f0f0;
                    cursor: pointer;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: #2e3338; font-size: 14px; margin-bottom: 4px;">
                                ${item.item_code}
                            </div>
                            <div style="color: #6c757d; font-size: 13px; margin-bottom: 6px;">
                                ${item.item_name}
                            </div>
                            <div style="display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px;">
                                ${has_rate ? `
                                <span style="color: #2e7d32; font-weight: 600;">
                                    <svg style="width: 14px; height: 14px; vertical-align: text-bottom;" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                        <line x1="12" y1="1" x2="12" y2="23"></line>
                                        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
                                    </svg>
                                    ${format_number(item.rate, null, 2)}
                                </span>
                                ` : `
                                    <span style="color: #6c757d;">
                                        ${item.stock_uom ? `UOM: ${item.stock_uom}` : ''}
                                    </span>
                                `}
                                ${has_stock ? `
                                <span class="stock-badge ${stock_class}">
                                    ${stock_text}
                                </span>
                                ` : ''}
                                ${barcode_text ? `<span style="color: #888;">🏷️ ${frappe.utils.escape_html(barcode_text)}</span>` : ''}
                                ${item.item_group ? `<span style="color: #888;">📦 ${item.item_group}</span>` : ''}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        results_div.innerHTML = html;
        results_div.style.display = 'block';

        // Default-select (hover) first item for fast Enter-to-add workflow
        if (items_list.length > 0) {
            selected_index = 0;
            highlight_selected_so();
        }

        // Add mouse event handlers
        results_div.querySelectorAll('.search-result-item').forEach((elem, index) => {
            elem.addEventListener('mouseenter', function () {
                selected_index = parseInt(this.dataset.index);
                highlight_selected_so();
            });

            elem.addEventListener('click', function () {
                const index = parseInt(this.dataset.index);
                // Click behaves like Enter: select/prep item (do not add immediately)
                prepare_item_for_add_so(items_list[index]);
            });
        });
    }

    function highlight_selected_so() {
        results_div.querySelectorAll('.search-result-item').forEach((elem, index) => {
            if (index === selected_index) {
                elem.classList.add('selected');
                elem.style.background = '#e8f5e9';
            } else {
                elem.classList.remove('selected');
                elem.style.background = 'white';
            }
        });
    }

    function scroll_to_selected_so() {
        if (selected_index < 0) return;

        const selected_elem = results_div.querySelector(`[data-index="${selected_index}"]`);
        if (selected_elem) {
            selected_elem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', function (e) {
        if (!input.contains(e.target) && !results_div.contains(e.target)) {
            results_div.style.display = 'none';
        }
    });

    // UOM dropdown behavior (searchable dropdown like item list)
    if (uom_input) {
        uom_input.addEventListener('focus', function () {
            render_uom_dropdown_so(uom_input.value);
        });
        uom_input.addEventListener('input', function () {
            render_uom_dropdown_so(uom_input.value);
        });
        uom_input.addEventListener('keydown', function (e) {
            if (!uom_results || uom_results.style.display === 'none') return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                uom_selected_index = Math.min(uom_selected_index + 1, (uom_results.querySelectorAll('.uom-result-item').length - 1));
                highlight_uom_selected_so();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                uom_selected_index = Math.max(uom_selected_index - 1, 0);
                highlight_uom_selected_so();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const els = uom_results.querySelectorAll('.uom-result-item');
                const el = els[uom_selected_index];
                if (el) {
                    const selected_uom = (el.textContent || '').trim();
                    uom_input.value = selected_uom;
                    hide_uom_dropdown_so();
                    // Re-fetch last price for the new UOM
                    if (pending_item) fetch_and_display_last_price(pending_item.item_code, selected_uom);
                    setTimeout(() => rate_input && rate_input.focus(), 10);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hide_uom_dropdown_so();
            }
        });
    }

    document.addEventListener('click', function (e) {
        if (uom_input && uom_results && !uom_input.contains(e.target) && !uom_results.contains(e.target)) {
            hide_uom_dropdown_so();
        }
    });

    // Expose a tiny hook so add_item_to_table_so can lock Enter spamming
    input._dr_set_add_in_progress = function (v) {
        add_in_progress = !!v;
    };

    // Clear controls if user starts typing a new search
    input.addEventListener('input', function () {
        if (pending_item) {
            clear_controls_so();
        }
    });
}

// ═══════════════════════════════════════════════════════
//  ADD ITEM TO TABLE (backend call)
// ═══════════════════════════════════════════════════════

let DR_RECALC_TIMER = null;
function schedule_recalculate_so(frm) {
    clearTimeout(DR_RECALC_TIMER);
    DR_RECALC_TIMER = setTimeout(() => {
        frm.script_manager.trigger('calculate_taxes_and_totals');
    }, 200);
}

function add_item_to_table_so(frm, item, opts) {
    if (!item || !item.item_code) return;
    opts = opts || {};

    // Check if form is editable
    if (frm.doc.docstatus !== 0) {
        frappe.msgprint(__('Cannot add items to submitted order'));
        return;
    }

    // Show lightweight loading
    const input = document.getElementById('quick_item_search');
    const loading_icon = document.getElementById('search_loading');
    if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(true);
    if (loading_icon) loading_icon.style.display = 'block';

    const target_uom = opts.uom || item.stock_uom || '';
    const has_custom_rate = opts.rate !== undefined && opts.rate !== null && opts.rate !== '' && !Number.isNaN(opts.rate);

    // Check if item already exists with the SAME UOM → just increment qty
    let existing_row = null;
    (frm.doc.items || []).forEach(row => {
        if (row.item_code === item.item_code && (!target_uom || row.uom === target_uom)) {
            existing_row = row;
        }
    });

    if (existing_row) {
        // Existing row: bump qty and set rate priority: custom rate > last price > keep existing
        const new_qty = existing_row.qty + (opts.qty || 1);
        const has_last_price = opts.last_price !== undefined && opts.last_price !== null && !Number.isNaN(opts.last_price) && opts.last_price > 0;
        let effective_rate = existing_row.rate; // default: keep existing rate
        if (has_custom_rate) {
            effective_rate = opts.rate;
        } else if (has_last_price) {
            effective_rate = opts.last_price;
        }
        frappe.model.set_value(existing_row.doctype, existing_row.name, 'qty', new_qty);
        frappe.model.set_value(existing_row.doctype, existing_row.name, 'rate', effective_rate);
        frappe.model.set_value(existing_row.doctype, existing_row.name, 'amount',
            new_qty * flt(effective_rate));
        move_item_row_to_top_so(frm, existing_row);
        cleanup_empty_item_rows_so(frm);
        frm.refresh_field('items');
        schedule_recalculate_so(frm);
        if (loading_icon) loading_icon.style.display = 'none';
        if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(false);
        const qi = document.getElementById('quick_item_search');
        if (qi) qi.value = '';
        const sr = document.getElementById('search_results');
        if (sr) sr.style.display = 'none';
        setTimeout(() => qi && qi.focus(), 50);
        return;
    }

    // New row: single backend call to get all item details
    frappe.call({
        method: 'sales_order_customization.api.sales_order_actions.get_item_details_for_sales_order',
        args: {
            item_code: item.item_code,
            company: frm.doc.company,
            customer: frm.doc.customer || '',
            currency: frm.doc.currency || '',
            price_list: frm.doc.selling_price_list || '',
            qty: opts.qty || 1,
            uom: target_uom,
            warehouse: frm.doc.set_warehouse || '',
            conversion_rate: frm.doc.conversion_rate || 1,
            transaction_date: frm.doc.transaction_date || frm.doc.delivery_date || '',
            ignore_pricing_rule: frm.doc.ignore_pricing_rule || 0,
        },
        async: true,
        callback: function (r) {
            try {
                if (!r || !r.message) {
                    frappe.show_alert({ message: __('Could not fetch item details'), indicator: 'red' }, 3);
                    return;
                }

                const details = r.message;
                const child_doctype = (frm.fields_dict.items && frm.fields_dict.items.grid && frm.fields_dict.items.grid.doctype)
                    ? frm.fields_dict.items.grid.doctype
                    : 'Sales Order Item';
                const row = frappe.model.add_child(frm.doc, child_doctype, 'items', 1);

                // Mark this row so the item_code event handler knows to skip
                // re-fetching details (rate, uom, qty are already set here).
                row._added_via_quick_search = true;

                // Populate all fields directly from backend response — no client-side triggers needed
                const fields_to_set = [
                    'item_code', 'item_name', 'description', 'image',
                    'uom', 'stock_uom', 'conversion_factor',
                    'warehouse', 'income_account', 'cost_center',
                    'price_list_rate', 'base_price_list_rate',
                    'discount_percentage', 'discount_amount',
                    'rate', 'base_rate', 'net_rate',
                    'item_tax_template', 'item_tax_rate',
                    'item_group', 'brand',
                    'has_serial_no', 'has_batch_no',
                    'weight_per_unit', 'weight_uom', 'total_weight',
                    'grant_commission', 'valuation_rate',
                ];

                fields_to_set.forEach(field => {
                    if (details[field] !== undefined && details[field] !== null) {
                        row[field] = details[field];
                    }
                });

                // Set qty and compute amounts
                row.qty = flt(opts.qty || 1);
                row.stock_qty = flt(row.qty) * flt(row.conversion_factor || 1);

                // If user typed a custom rate in search bar, use it; otherwise use backend rate
                if (has_custom_rate) {
                    row.rate = flt(opts.rate);
                } else {
                    row.rate = flt(details.rate || details.price_list_rate || 0);
                }
                row.price_list_rate = flt(details.price_list_rate || row.rate);
                row.amount = flt(row.qty * row.rate);
                row.base_rate = flt(row.rate * (frm.doc.conversion_rate || 1));
                row.base_amount = flt(row.amount * (frm.doc.conversion_rate || 1));
                row.net_rate = row.rate;
                row.net_amount = row.amount;

                // Set custom_last_rate from backend
                row.custom_last_rate = flt(details.custom_last_rate || 0);

                // Set delivery_date from parent if not set
                row.delivery_date = frm.doc.delivery_date || '';

                // Trigger stock qty + valuation_rate_with_uom calculation
                // (mirrors the behavior of the standard item_code field trigger)
                if (row.item_code && row.warehouse) {
                    update_actual_qty_in_uom(frm, row.doctype, row.name);
                }

                cleanup_empty_item_rows_so(frm);
                frm.refresh_field('items');
                schedule_recalculate_so(frm);

            } finally {
                if (loading_icon) loading_icon.style.display = 'none';
                if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(false);
                const qi = document.getElementById('quick_item_search');
                if (qi) qi.value = '';
                const sr = document.getElementById('search_results');
                if (sr) sr.style.display = 'none';
                setTimeout(() => qi && qi.focus(), 50);
            }
        },
        error: function () {
            if (loading_icon) loading_icon.style.display = 'none';
            if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(false);
            frappe.show_alert({ message: __('Error fetching item details'), indicator: 'red' }, 3);
        }
    });
}
