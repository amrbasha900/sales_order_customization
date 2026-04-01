// ═══════════════════════════════════════════════════════
//  ITEM DASHBOARD UI
// ═══════════════════════════════════════════════════════

function show_item_dashboard_dialog(frm, row) {
    const dialog = new frappe.ui.Dialog({
        title: __("Item Dashboard: {0}", [row.item_code]),
        size: "extra-large",
        fields: [
            {
                fieldname: "dashboard_html",
                fieldtype: "HTML"
            }
        ]
    });

    const unique_id = frappe.utils.get_random(8);
    const html = `
        <div class="item-dashboard-container">
            <ul class="nav nav-tabs" role="tablist">
                <li class="nav-item">
                    <a class="nav-link active" data-toggle="tab" data-target="#tab-stock-${unique_id}" role="tab" style="cursor: pointer;">${__("Warehouse Stock")}</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" data-toggle="tab" data-target="#tab-sales-${unique_id}" role="tab" style="cursor: pointer;">${__("Sales History")}</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" data-toggle="tab" data-target="#tab-purchases-${unique_id}" role="tab" style="cursor: pointer;">${__("Purchase History")}</a>
                </li>
            </ul>
            <div class="tab-content" style="padding-top: 15px; min-height: 300px;">
                <div class="tab-pane active" id="tab-stock-${unique_id}" role="tabpanel">
                    <div class="text-muted">${__("Loading...")}</div>
                </div>
                <div class="tab-pane" id="tab-sales-${unique_id}" role="tabpanel">
                    <div class="text-muted">${__("Loading...")}</div>
                </div>
                <div class="tab-pane" id="tab-purchases-${unique_id}" role="tabpanel">
                    <div class="text-muted">${__("Loading...")}</div>
                </div>
            </div>
        </div>
    `;

    dialog.fields_dict.dashboard_html.$wrapper.html(html);

    dialog.show();

    load_warehouse_stock(frm, row.item_code, dialog.fields_dict.dashboard_html.$wrapper.find(`#tab-stock-${unique_id}`));

    let sales_loaded = false;
    let purchases_loaded = false;

    dialog.fields_dict.dashboard_html.$wrapper.find('a[data-toggle="tab"]').on('shown.bs.tab', function (e) {
        const target = $(e.target).attr("data-target");
        if (target === `#tab-sales-${unique_id}` && !sales_loaded) {
            sales_loaded = true;
            load_sales_history(row.item_code, dialog.fields_dict.dashboard_html.$wrapper.find(`#tab-sales-${unique_id}`), frm.doc.currency);
        } else if (target === `#tab-purchases-${unique_id}` && !purchases_loaded) {
            purchases_loaded = true;
            load_purchase_history(row.item_code, dialog.fields_dict.dashboard_html.$wrapper.find(`#tab-purchases-${unique_id}`), frm.doc.currency);
        }
    });
}

function load_warehouse_stock(frm, item_code, $wrapper) {
    frappe.call({
        method: "sales_order_customization.api.sales_order_actions.get_item_warehouse_data",
        args: {
            item_code: item_code,
            company: frm.doc.company
        },
        callback: function (r) {
            $wrapper.empty();
            let data = r.message || [];
            if (!data.length) {
                $wrapper.html(`<div class="text-muted">${__("No stock data found.")}</div>`);
                return;
            }
            let table = `<table class="table table-bordered table-hover">
                <thead>
                    <tr>
                        <th>${__("Warehouse")}</th>
                        <th class="text-right">${__("Actual Qty")}</th>
                        <th class="text-right">${__("Projected Qty")}</th>
                        <th class="text-right">${__("Reserved Qty")}</th>
                    </tr>
                </thead>
                <tbody>`;
            data.forEach(d => {
                table += `<tr>
                    <td><strong>${d.warehouse_name || d.warehouse}</strong></td>
                    <td class="text-right"><span class="badge badge-${d.actual_qty > 0 ? 'success' : 'danger'}">${flt(d.actual_qty)}</span></td>
                    <td class="text-right">${flt(d.projected_qty)}</td>
                    <td class="text-right">${flt(d.reserved_qty)}</td>
                </tr>`;
            });
            table += `</tbody></table>`;
            $wrapper.html(table);
            setup_table_sorting($wrapper.find('table'));
        }
    });
}

function load_sales_history(item_code, $wrapper, currency) {
    let start = 0;
    const limit = 5;

    $wrapper.html(`
        <table class="table table-bordered table-hover sales-table">
            <thead>
                <tr>
                    <th>${__("Date")}</th>
                    <th>${__("Sales Invoice")}</th>
                    <th>${__("Customer")}</th>
                    <th class="text-right">${__("Rate")}</th>
                    <th class="text-right">${__("Qty")}</th>
                    <th>${__("UOM")}</th>
                    <th class="text-right">${__("Amount")}</th>
                </tr>
            </thead>
            <tbody></tbody>
        </table>
        <div class="text-center mt-3 mb-2">
            <button class="btn btn-default btn-sm btn-load-more hidden">${__("Load More")}</button>
        </div>
    `);

    setup_table_sorting($wrapper.find('table'));

    const $tbody = $wrapper.find('tbody');
    const $btn = $wrapper.find('.btn-load-more');

    const fetch_data = () => {
        $btn.prop('disabled', true).text(__("Loading..."));
        frappe.call({
            method: "sales_order_customization.api.sales_order_actions.get_item_sales_history",
            args: { item_code: item_code, start: start, limit: limit },
            callback: function (r) {
                let data = r.message || [];
                render_history_rows(data, $tbody, 'sales', currency);
                if (data.length === limit) {
                    $btn.removeClass('hidden').prop('disabled', false).text(__("Load More"));
                    start += limit;
                } else {
                    $btn.addClass('hidden');
                }
                if (start === 0 && data.length === 0) {
                    $tbody.html(`<tr><td colspan="6" class="text-muted text-center">${__("No sales history found.")}</td></tr>`);
                }
            }
        });
    };

    $btn.on('click', fetch_data);
    fetch_data();
}

function load_purchase_history(item_code, $wrapper, currency) {
    let start = 0;
    const limit = 5;

    $wrapper.html(`
        <table class="table table-bordered table-hover purchase-table">
            <thead>
                <tr>
                    <th>${__("Date")}</th>
                    <th>${__("Purchase Invoice")}</th>
                    <th>${__("Supplier")}</th>
                    <th class="text-right">${__("Rate")}</th>
                    <th class="text-right">${__("Qty")}</th>
                    <th>${__("UOM")}</th>
                    <th class="text-right">${__("Amount")}</th>
                </tr>
            </thead>
            <tbody></tbody>
        </table>
        <div class="text-center mt-3 mb-2">
            <button class="btn btn-default btn-sm btn-load-more hidden">${__("Load More")}</button>
        </div>
    `);

    setup_table_sorting($wrapper.find('table'));

    const $tbody = $wrapper.find('tbody');
    const $btn = $wrapper.find('.btn-load-more');

    const fetch_data = () => {
        $btn.prop('disabled', true).text(__("Loading..."));
        frappe.call({
            method: "sales_order_customization.api.sales_order_actions.get_item_purchase_history",
            args: { item_code: item_code, start: start, limit: limit },
            callback: function (r) {
                let data = r.message || [];
                render_history_rows(data, $tbody, 'purchase', currency);
                if (data.length === limit) {
                    $btn.removeClass('hidden').prop('disabled', false).text(__("Load More"));
                    start += limit;
                } else {
                    $btn.addClass('hidden');
                }
                if (start === 0 && data.length === 0) {
                    $tbody.html(`<tr><td colspan="6" class="text-muted text-center">${__("No purchase history found.")}</td></tr>`);
                }
            }
        });
    };

    $btn.on('click', fetch_data);
    fetch_data();
}

function render_history_rows(data, $tbody, type, currency) {
    data.forEach(d => {
        let party = type === 'sales' ? d.customer : d.supplier;
        let p_url = type === 'sales' ? `/app/customer/${party}` : `/app/supplier/${party}`;
        let doc_url = type === 'sales' ? `/app/sales-invoice/${d.invoice_name}` : `/app/purchase-invoice/${d.invoice_name}`;

        let f_rate = format_currency(d.rate, currency);
        let f_amount = format_currency(d.amount, currency);

        let row_html = `
            <tr>
                <td>${frappe.datetime.str_to_user(d.posting_date)}</td>
                <td><a href="${doc_url}" target="_blank"><strong>${d.invoice_name}</strong></a></td>
                <td><a href="${p_url}" target="_blank">${party}</a></td>
                <td class="text-right" data-value="${flt(d.rate)}">${f_rate}</td>
                <td class="text-right" data-value="${flt(d.qty)}">${flt(d.qty)}</td>
                <td>${d.uom || ''}</td>
                <td class="text-right" data-value="${flt(d.amount)}"><strong>${f_amount}</strong></td>
            </tr>
        `;
        $tbody.append(row_html);
    });
}

// ═══════════════════════════════════════════════════════
//  TABLE SORTING HELPER
// ═══════════════════════════════════════════════════════

function setup_table_sorting($table) {
    $table.find('th').css('cursor', 'pointer').attr('title', __("Click to sort"));
    $table.find('th').on('click', function () {
        const table = $(this).parents('table').eq(0);
        const rows = table.find('tbody tr').toArray().sort(comparer($(this).index()));
        this.asc = !this.asc;
        if (!this.asc) { rows.reverse(); }
        for (let i = 0; i < rows.length; i++) {
            table.find('tbody').append(rows[i]);
        }
    });
}

function comparer(index) {
    return function (a, b) {
        const valA = getCellValue(a, index), valB = getCellValue(b, index);
        return $.isNumeric(valA) && $.isNumeric(valB) ? valA - valB : valA.toString().localeCompare(valB);
    };
}

function getCellValue(row, index) {
    const td = $(row).children('td').eq(index);
    if (td.attr('data-value')) {
        return td.attr('data-value');
    }
    const val = td.text().replace(/[\$,]/g, '');
    return val;
}
