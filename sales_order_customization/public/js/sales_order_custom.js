/**
 * Sales Order Customization
 *
 * - "Submit & Pay" button on draft SO → dialog with payments table → submit SO + auto-create SI + PEs
 * - Standard Submit button works normally (no invoice/payment)
 * - "Create Return" button on submitted SO → simplified dialog with return reason + multi-refund table
 */

frappe.ui.form.on("Sales Order", {
    onload(frm) {
        if (frm.is_new() && !frm.doc.delivery_date) {
            frm.set_value("delivery_date", frappe.datetime.get_today());
        }
        remove_rows_without_item_code_so(frm);
        setup_barcode_scanner_so(frm);
    },

    refresh(frm) {
        // Add quick item search field at the top
        add_quick_item_search_so(frm);

        // Add recent items button
        add_recent_items_button_so(frm);

        // Offline full-sync (IndexedDB) + local-only search
        add_offline_items_sync_button_so(frm);

        // Remove default empty row(s) in items table
        cleanup_default_empty_item_rows_so(frm);

        // Add per-row Details buttons in the items grid
        attach_items_grid_details_buttons_so(frm);
        setTimeout(() => attach_items_grid_details_buttons_so(frm), 300);

        // ── Draft: show "Submit & Pay" button ─────────
        if (frm.doc.docstatus === 0 && !frm.is_new()) {
            frm.add_custom_button(
                __("Submit & Pay"),
                () => show_submit_and_pay_dialog(frm),
            );
            frm.custom_buttons[__("Submit & Pay")]
                && frm.custom_buttons[__("Submit & Pay")].addClass("btn-primary-dark");
        }

        // ── Submitted: show "Create Return" and "Print Invoice" as top-level buttons ────
        if (frm.doc.docstatus !== 1) return;
        if (["Cancelled", "Closed"].includes(frm.doc.status)) return;

        // Print Invoice button
        if (["To Deliver and Bill", "To Bill", "To Deliver", "Completed"].includes(frm.doc.status)) {
            frm.add_custom_button(
                __("Print Invoice"),
                function () {
                    frappe.call({
                        method: "sales_order_customization.api.sales_order_actions.get_sales_invoice_print_url",
                        args: { sales_order: frm.doc.name },
                        callback: function (r) {
                            if (r.message && r.message.url) {
                                window.open(r.message.url, "_blank");
                            }
                        }
                    });
                }
            );
            frm.custom_buttons[__("Print Invoice")]
                && frm.custom_buttons[__("Print Invoice")].addClass("btn-default");
        }

        // Create Return button
        frappe.call({
            method: "sales_order_customization.api.sales_order_actions.get_returnable_items",
            args: { sales_order: frm.doc.name },
            async: true,
            callback(r) {
                if (r.message && r.message.length) {
                    frm.add_custom_button(
                        __("Create Return"),
                        () => show_return_dialog(frm, r.message),
                    );
                    frm.custom_buttons[__("Create Return")]
                        && frm.custom_buttons[__("Create Return")].addClass("btn-default");
                }
            }
        });

        // Print Sales Return button
        frappe.call({
            method: "sales_order_customization.api.sales_order_actions.get_sales_returns",
            args: { sales_order: frm.doc.name },
            callback: function (r) {
                if (r.message && r.message.length) {
                    frm.add_custom_button(
                        __("Print Sales Return"),
                        function () {
                            handle_print_sales_return(frm, r.message);
                        }
                    );
                    frm.custom_buttons[__("Print Sales Return")]
                        && frm.custom_buttons[__("Print Sales Return")].addClass("btn-default");
                }
            }
        });
    },


    selling_price_list: function (frm) {
        if (frm.custom_item_search) {
            $('#quick_item_search').val('');
            $('#search_results').hide();
        }
    },
    customer(frm) {
        if (frm.custom_item_search) {
            $('#quick_item_search').val('');
            $('#search_results').hide();
        }
        remove_rows_without_item_code_so(frm);
        toggle_quick_add_visibility_so(frm);

        if (frm.doc.customer && frm.doc.company) {
            // Fetch customer outstanding amount  
            frappe.call({
                method: 'sales_order_customization.api.sales_order_actions.get_customer_outstanding_amount',
                args: {
                    customer: frm.doc.customer,
                    company: frm.doc.company
                },
                callback: function (r) {
                    if (r.message !== undefined) {
                        frm.set_value('custom_customer_balance', r.message);
                    }
                }
            });
        } else {
            frm.set_value('custom_customer_balance', 0);
        }

        if (!frm.doc.customer || !frm.doc.items || !frm.doc.items.length) return;

        // Iterate through all items and update the custom_last_rate for the new customer
        frm.doc.items.forEach(row => {
            if (row.item_code) {
                frappe.call({
                    method: "sales_order_customization.api.sales_order_actions.get_last_sales_rate",
                    args: {
                        customer: frm.doc.customer,
                        item_code: row.item_code,
                        uom: row.uom
                    },
                    callback: function (r) {
                        if (r.message !== undefined) {
                            frappe.model.set_value(row.doctype, row.name, "custom_last_rate", flt(r.message));
                        }
                    }
                });
            }
        });

    }
});

// ═══════════════════════════════════════════════════════
//  SUBMIT & PAY DIALOG
// ═══════════════════════════════════════════════════════

function show_submit_and_pay_dialog(frm) {
    const grand_total = flt(frm.doc.grand_total) || flt(frm.doc.rounded_total) || 0;

    const d = new frappe.ui.Dialog({
        title: __("Submit & Pay"),
        size: "large",
        fields: [
            {
                fieldname: "total_info",
                fieldtype: "HTML",
                options: `<div class="text-muted" style="margin-bottom:10px;">
                    ${__("Grand Total")}: <strong>${format_currency(grand_total, frm.doc.currency)}</strong>
                </div>`,
            },
            {
                fieldname: "create_without_payment",
                fieldtype: "Check",
                label: __("Create Invoice without Payment"),
                default: 0
            },
            {
                fieldname: "payments",
                fieldtype: "Table",
                label: __("Payments"),
                cannot_add_rows: false,
                in_place_edit: true,
                fields: [
                    {
                        fieldname: "mode_of_payment",
                        fieldtype: "Link",
                        options: "Mode of Payment",
                        label: __("Mode of Payment"),
                        in_list_view: 1,
                        reqd: 1,
                        columns: 3,
                    },
                    {
                        fieldname: "amount",
                        fieldtype: "Currency",
                        label: __("Amount"),
                        in_list_view: 1,
                        reqd: 1,
                        columns: 2,
                    },
                    {
                        fieldname: "reference_no",
                        fieldtype: "Data",
                        label: __("Reference / Cheque No"),
                        in_list_view: 1,
                        columns: 3,
                    },
                    {
                        fieldname: "reference_date",
                        fieldtype: "Date",
                        label: __("Reference Date"),
                        in_list_view: 1,
                        columns: 2,
                    },
                ],
                data: [],
            },
        ],
        primary_action_label: __("Submit & Pay"),
        primary_action(values) {
            const create_without_payment = !!values.create_without_payment;
            const payments = values.payments || [];

            if (!create_without_payment) {
                if (!payments.length) {
                    frappe.msgprint(__("Please add at least one payment row."));
                    return;
                }

                let total_payment = 0;
                for (const [idx, p] of payments.entries()) {
                    if (!p.mode_of_payment) {
                        frappe.msgprint(__("Row {0}: Mode of Payment is required.", [idx + 1]));
                        return;
                    }
                    if (flt(p.amount) <= 0) {
                        frappe.msgprint(__("Row {0}: Amount must be greater than zero.", [idx + 1]));
                        return;
                    }
                    total_payment += flt(p.amount);
                }

                if (flt(total_payment, 2) !== flt(grand_total, 2)) {
                    frappe.msgprint(
                        __("Total payment ({0}) must match Grand Total ({1}).", [
                            format_currency(total_payment, frm.doc.currency),
                            format_currency(grand_total, frm.doc.currency),
                        ])
                    );
                    return;
                }
            }

            d.hide();

            (frm.is_dirty() ? frm.save() : Promise.resolve()).then(() => {
                return frappe.xcall(
                    "sales_order_customization.api.sales_order_actions.auto_create_invoice_and_payment",
                    {
                        sales_order: frm.doc.name,
                        create_without_payment: create_without_payment ? 1 : 0,
                        payments: payments.map((p) => ({
                            mode_of_payment: p.mode_of_payment,
                            amount: flt(p.amount),
                            reference_no: p.reference_no || "",
                            reference_date: p.reference_date || "",
                        })),
                    }
                );
            })
                .then((result) => {
                    let msg = __("Sales Invoice {0} created and submitted.", [
                        `<a href="/app/sales-invoice/${result.sales_invoice}">${result.sales_invoice}</a>`,
                    ]);
                    (result.payment_entries || []).forEach((pe_name) => {
                        msg += "<br>" + __("Payment Entry {0} created.", [
                            `<a href="/app/payment-entry/${pe_name}">${pe_name}</a>`,
                        ]);
                    });
                    frappe.show_alert({ message: msg, indicator: "green" }, 5);
                    frm.reload_doc();
                })
                .catch((err) => {
                    frappe.msgprint({
                        message: __("An error occurred. Please check the error log and try again."),
                        indicator: "red",
                        title: __("Error"),
                    });
                    frm.reload_doc();
                });
        },
    });

    // ── Auto-fill amount on new row ─────────────────────
    d.show();
    setup_payment_grid_auto_amount(d, "payments", () => grand_total);
}

// ═══════════════════════════════════════════════════════
//  RETURN DIALOG (simplified – single invoice per SO)
// ═══════════════════════════════════════════════════════

function show_return_dialog(frm, rows) {
    let calculated_grand_total = 0;

    const dialog = show_action_dialog({
        title: __("Create Sales Return / Credit Note"),
        frm,
        rows,
        columns: get_return_columns(),
        on_change(selected) {
            if (!selected.length) {
                calculated_grand_total = 0;
                dialog.fields_dict.total_refund_info.$wrapper.html("");
                return;
            }

            frappe.call({
                method: "sales_order_customization.api.sales_order_actions.calculate_return_totals",
                args: {
                    args: JSON.stringify({
                        items: selected.map(r => ({
                            sales_invoice: r.sales_invoice,
                            si_item_name: r.si_item_name,
                            qty: flt(r.qty)
                        }))
                    })
                },
                callback(r) {
                    if (r.message) {
                        calculated_grand_total = flt(r.message.total_grand_total);
                        const html = `
                            <div class="alert alert-info" style="margin-top:10px; margin-bottom:0;">
                                ${__("Expected Refund Amount (Incl. Taxes)")}: 
                                <strong>${format_currency(calculated_grand_total, frm.doc.currency)}</strong>
                            </div>
                        `;
                        dialog.fields_dict.total_refund_info.$wrapper.html(html);
                    }
                }
            });
        },
        row_mapper: (r) => ({
            sales_invoice: r.sales_invoice,
            si_item_name: r.si_item_name,
            so_detail: r.so_detail,
            item_code: r.item_code,
            item_name: r.item_name,
            invoiced_qty: r.invoiced_qty,
            already_returned_qty: r.already_returned_qty,
            remaining_qty: r.remaining_qty,
            qty: r.remaining_qty,
            rate: r.rate,
            amount: r.amount,
        }),
        qty_field: "qty",
        max_qty_field: "remaining_qty",
        option_fields: [
            {
                fieldname: "total_refund_info",
                fieldtype: "HTML",
            },
            {
                fieldname: "return_reason",
                label: __("Return Reason"),
                fieldtype: "Data",
                reqd: 1,
            },
            { fieldtype: "Section Break" },
            {
                fieldname: "create_without_refund",
                label: __("Create Return without Refund"),
                fieldtype: "Check",
                default: 0,
            },
            {
                fieldname: "refund_payments_section",
                fieldtype: "Section Break",
                label: __("Refund Payments"),
            },
            {
                fieldname: "refund_payments",
                fieldtype: "Table",
                label: __("Refund Payments"),
                cannot_add_rows: false,
                in_place_edit: true,
                fields: [
                    {
                        fieldname: "mode_of_payment",
                        fieldtype: "Link",
                        options: "Mode of Payment",
                        label: __("Mode of Payment"),
                        in_list_view: 1,
                        reqd: 1,
                        columns: 3,
                    },
                    {
                        fieldname: "amount",
                        fieldtype: "Currency",
                        label: __("Amount"),
                        in_list_view: 1,
                        reqd: 1,
                        columns: 2,
                    },
                    {
                        fieldname: "reference_no",
                        fieldtype: "Data",
                        label: __("Reference / Cheque No"),
                        in_list_view: 1,
                        columns: 3,
                    },
                    {
                        fieldname: "reference_date",
                        fieldtype: "Date",
                        label: __("Reference Date"),
                        in_list_view: 1,
                        columns: 2,
                    },
                ],
                data: [],
            },
        ],
        on_submit(selected, opts) {
            if (!selected.length) {
                frappe.msgprint(__("Please select at least one item."));
                return;
            }

            if (!opts.return_reason) {
                frappe.msgprint(__("Return Reason is required."));
                return;
            }

            for (const row of selected) {
                if (flt(row.qty) <= 0) {
                    frappe.msgprint(__("Qty to Return must be greater than zero for {0}.", [row.item_code]));
                    return;
                }
                if (flt(row.qty) > flt(row.remaining_qty)) {
                    frappe.msgprint(
                        __("Qty to Return ({0}) exceeds Remaining Returnable Qty ({1}) for {2}.", [
                            row.qty,
                            row.remaining_qty,
                            row.item_code,
                        ])
                    );
                    return;
                }
            }

            const create_without_refund = opts.create_without_refund;
            let refund_payments = opts.refund_payments || [];

            let total_refund = 0;
            for (const [idx, p] of refund_payments.entries()) {
                if (!p.mode_of_payment) {
                    frappe.msgprint(__("Refund Row {0}: Mode of Payment is required.", [idx + 1]));
                    return;
                }
                if (flt(p.amount) <= 0) {
                    frappe.msgprint(__("Refund Row {0}: Amount must be greater than zero.", [idx + 1]));
                    return;
                }
                total_refund += flt(p.amount);
            }

            if (!create_without_refund) {
                if (!refund_payments.length) {
                    frappe.msgprint(__("Please add at least one refund payment row. Or check 'Create Return without Refund'."));
                    return;
                }
                if (flt(total_refund, 2) !== flt(calculated_grand_total, 2)) {
                    frappe.msgprint(
                        __("Total refund amount ({0}) must match Total Return Incl. Taxes ({1}).", [
                            format_currency(total_refund, frm.doc.currency),
                            format_currency(calculated_grand_total, frm.doc.currency),
                        ])
                    );
                    return;
                }
            } else {
                if (flt(total_refund, 2) > flt(calculated_grand_total, 2)) {
                    frappe.msgprint(
                        __("Total refund amount ({0}) cannot exceed Total Return Incl. Taxes ({1}).", [
                            format_currency(total_refund, frm.doc.currency),
                            format_currency(calculated_grand_total, frm.doc.currency),
                        ])
                    );
                    return;
                }
            }

            dialog.hide();

            frappe.call({
                method: "sales_order_customization.api.sales_order_actions.create_sales_return",
                args: {
                    args: JSON.stringify({
                        sales_order: frm.doc.name,
                        items: selected.map((r) => ({
                            sales_invoice: r.sales_invoice,
                            si_item_name: r.si_item_name,
                            qty: flt(r.qty),
                        })),
                        submit: 1,
                        return_reason: opts.return_reason || "",
                        create_without_refund: create_without_refund ? 1 : 0,
                        payments: refund_payments.map((p) => ({
                            mode_of_payment: p.mode_of_payment,
                            amount: flt(p.amount),
                            reference_no: p.reference_no || "",
                            reference_date: p.reference_date || "",
                        })),
                    }),
                },
                freeze: true,
                freeze_message: __("Creating Sales Return…"),
                callback(r) {
                    if (r.message) {
                        let msg = "";
                        (r.message.returns || []).forEach((name) => {
                            msg += __("Credit Note {0} created.", [
                                `<a href="/app/sales-invoice/${name}">${name}</a>`,
                            ]) + "<br>";
                        });
                        (r.message.payment_entries || []).forEach((name) => {
                            msg += __("Refund Payment Entry {0} created.", [
                                `<a href="/app/payment-entry/${name}">${name}</a>`,
                            ]) + "<br>";
                        });
                        frappe.show_alert({ message: msg, indicator: "green" }, 5);
                        frm.reload_doc();
                    }
                },
            });
        },
    });

    // ── Auto-fill amount on new row ─────────────────────
    // Uses a lazy getter () => calculated_grand_total so it always reads
    // the latest value after on_change updates it via frappe.call
    setup_payment_grid_auto_amount(
        dialog,
        "refund_payments",
        () => calculated_grand_total
    );
}

// ═══════════════════════════════════════════════════════
//  AUTO-FILL REMAINING AMOUNT ON NEW PAYMENT ROW
// ═══════════════════════════════════════════════════════

function setup_payment_grid_auto_amount(dialog, fieldname, get_total_fn) {
    const grid = dialog.fields_dict[fieldname] && dialog.fields_dict[fieldname].grid;
    if (!grid) return;

    const original_add_new_row = grid.add_new_row.bind(grid);

    grid.add_new_row = function (...args) {
        const result = original_add_new_row(...args);

        const data = grid.get_data() || [];
        if (!data.length) return result;

        const last_row = data[data.length - 1];
        if (!last_row) return result;

        // Sum all rows except the last (newly added) one
        let already_filled = 0;
        data.forEach((row, i) => {
            if (i < data.length - 1) {
                already_filled += flt(row.amount || 0);
            }
        });

        const total = flt(get_total_fn());
        const remaining = total - already_filled;

        // Set directly on the row object — dialog table rows have no doctype
        last_row.amount = remaining > 0 ? remaining : 0;

        grid.refresh();
        return result;
    };
}

// ═══════════════════════════════════════════════════════
//  REUSABLE DIALOG BUILDER
// ═══════════════════════════════════════════════════════

function show_action_dialog(opts) {
    const fields = [];

    fields.push({
        fieldname: "items_html",
        fieldtype: "HTML",
    });
    fields.push({ fieldtype: "Section Break" });
    fields.push(...(opts.option_fields || []));

    const dialog = new frappe.ui.Dialog({
        title: opts.title,
        size: "extra-large",
        fields,
        primary_action_label: __("Create"),
        primary_action() {
            const selected = get_selected_rows(dialog);
            const option_values = {};
            (opts.option_fields || []).forEach((f) => {
                if (f.fieldname) {
                    option_values[f.fieldname] = dialog.get_value(f.fieldname);
                }
            });
            opts.on_submit(selected, option_values);
        },
    });

    const all_mapped_rows = (opts.rows || []).map(opts.row_mapper);
    dialog._all_mapped_rows = all_mapped_rows;

    render_items_table(dialog, opts.columns, all_mapped_rows, opts.qty_field, opts.max_qty_field, opts.on_change);

    dialog.show();
    return dialog;
}

function render_items_table(dialog, columns, rows, qty_field, max_qty_field, on_change) {
    const wrapper = dialog.fields_dict.items_html.$wrapper;
    wrapper.empty();

    let html = `<div style="max-height:400px;overflow:auto;">
        <table class="table table-bordered table-hover" style="margin:0">
        <thead><tr>
            <th style="width:40px"><input type="checkbox" class="select-all"></th>`;

    columns.forEach((col) => {
        html += `<th>${col.label}</th>`;
    });
    html += `</tr></thead><tbody>`;

    rows.forEach((row, idx) => {
        html += `<tr data-idx="${idx}">
            <td><input type="checkbox" class="row-check" data-idx="${idx}"></td>`;
        columns.forEach((col) => {
            const val = row[col.fieldname] ?? "";
            if (col.fieldname === qty_field) {
                html += `<td><input type="number" class="form-control input-sm qty-input"
                    data-idx="${idx}" data-max="${row[max_qty_field]}"
                    value="${val}" min="0.001" max="${row[max_qty_field]}"
                    step="any" style="width:100px"></td>`;
            } else if (col.fieldtype === "Currency") {
                html += `<td class="text-right">${format_currency(val)}</td>`;
            } else if (col.fieldtype === "Float") {
                html += `<td class="text-right">${flt(val, 4)}</td>`;
            } else {
                html += `<td>${val}</td>`;
            }
        });
        html += `</tr>`;
    });

    html += `</tbody></table></div>`;
    wrapper.html(html);

    dialog._table_rows = rows;

    wrapper.find(".select-all").on("change", function () {
        wrapper.find(".row-check").prop("checked", this.checked);
        if (on_change) on_change(get_selected_rows(dialog));
    });

    wrapper.find(".row-check").on("change", function () {
        if (on_change) on_change(get_selected_rows(dialog));
    });

    wrapper.find(".qty-input").on("change input", function () {
        const idx = $(this).data("idx");
        const max = flt($(this).data("max"));
        let val = flt($(this).val());
        if (val > max) { val = max; $(this).val(val); }
        if (val < 0) { val = 0; $(this).val(val); }
        rows[idx][qty_field] = val;
        const rate = flt(rows[idx].rate);
        rows[idx].amount = val * rate;
        const amountTd = $(this).closest("tr").find("td").last();
        amountTd.text(format_currency(rows[idx].amount));

        if (on_change) on_change(get_selected_rows(dialog));
    });
}

function get_selected_rows(dialog) {
    const wrapper = dialog.fields_dict.items_html.$wrapper;
    const rows = dialog._table_rows || [];
    const selected = [];

    wrapper.find(".row-check:checked").each(function () {
        const idx = $(this).data("idx");
        selected.push(rows[idx]);
    });

    return selected;
}

// ═══════════════════════════════════════════════════════
//  COLUMN DEFINITIONS
// ═══════════════════════════════════════════════════════

function get_return_columns() {
    return [
        { fieldname: "item_code", label: __("Item Code"), fieldtype: "Data" },
        { fieldname: "item_name", label: __("Item Name"), fieldtype: "Data" },
        { fieldname: "invoiced_qty", label: __("Invoiced Qty"), fieldtype: "Float" },
        { fieldname: "already_returned_qty", label: __("Already Returned"), fieldtype: "Float" },
        { fieldname: "remaining_qty", label: __("Remaining Returnable"), fieldtype: "Float" },
        { fieldname: "qty", label: __("Qty to Return"), fieldtype: "Float" },
        { fieldname: "rate", label: __("Rate"), fieldtype: "Currency" },
        { fieldname: "amount", label: __("Amount"), fieldtype: "Currency" },
    ];
}

// ═══════════════════════════════════════════════════════
//  SALES ORDER ITEM EVENTS
// ═══════════════════════════════════════════════════════

frappe.ui.form.on("Sales Order Item", {
    item_code(frm, cdt, cdn) {
        update_last_sales_rate(frm, cdt, cdn);
        update_actual_qty_in_uom(frm, cdt, cdn);

    },

    uom(frm, cdt, cdn) {
        update_actual_qty_in_uom(frm, cdt, cdn);
        update_last_sales_rate(frm, cdt, cdn);

    },

    custom_action(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row.item_code) {
            frappe.msgprint(__("Please select an Item Code first."));
            return;
        }
        show_item_dashboard_dialog(frm, row);
    },
    warehouse(frm, cdt, cdn) {
        update_actual_qty_in_uom(frm, cdt, cdn);
    }
});

function update_actual_qty_in_uom(frm, cdt, cdn) {
    let row = locals[cdt][cdn];

    if (row.item_code && row.warehouse) {
        frappe.call({
            method: "sales_order_customization.api.sales_order_actions.get_item_stock_and_conversion",
            args: {
                item_code: row.item_code,
                warehouse: row.warehouse,
                uom: row.uom
            },
            callback: function (r) {
                if (r.message) {
                    let actual_qty = flt(r.message.actual_qty);
                    let cf = flt(r.message.conversion_factor) || 1;

                    // Update actual_qty (standard behavior)  
                    frappe.model.set_value(cdt, cdn, "actual_qty", actual_qty);

                    // Calculate and update converted quantity  
                    if (cf > 0) {
                        let converted_qty = actual_qty / cf;
                        frappe.model.set_value(cdt, cdn, "actual_qty_in_uom", converted_qty);
                    } else {
                        frappe.model.set_value(cdt, cdn, "actual_qty_in_uom", actual_qty);
                    }
                }
            },
        });
    }
}
// ═══════════════════════════════════════════════════════
//  ITEM RATE HELPERS
// ═══════════════════════════════════════════════════════

function update_last_sales_rate(frm, cdt, cdn) {
    const row = locals[cdt][cdn];

    if (!frm.doc.customer || !row.item_code) {
        frappe.model.set_value(cdt, cdn, "custom_last_rate", 0);
        return;
    }

    frappe.call({
        method: "sales_order_customization.api.sales_order_actions.get_last_sales_rate",
        args: {
            customer: frm.doc.customer,
            item_code: row.item_code,
            uom: row.uom
        },
        callback(r) {
            if (!r.exc) {
                frappe.model.set_value(cdt, cdn, "custom_last_rate", flt(r.message));
            }
        }
    });
}

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

// ═══════════════════════════════════════════════════════
//  PRINT SALES RETURN LOGIC
// ═══════════════════════════════════════════════════════

function handle_print_sales_return(frm, returns) {
    if (returns.length === 1) {
        // Direct print
        print_return_invoice(frm, returns[0].name);
    } else {
        // Show selection dialog
        const d = new frappe.ui.Dialog({
            title: __("Select Sales Return to Print"),
            fields: [
                {
                    label: __("Sales Return"),
                    fieldname: "return_invoice",
                    fieldtype: "Select",
                    options: returns.map(r => ({
                        label: `${r.name} (${frappe.datetime.str_to_user(r.posting_date)})`,
                        value: r.name
                    })),
                    reqd: 1
                }
            ],
            primary_action_label: __("Print"),
            primary_action(values) {
                print_return_invoice(frm, values.return_invoice);
                d.hide();
            }
        });
        d.show();
    }
}

function print_return_invoice(frm, invoice_name) {
    frappe.call({
        method: "sales_order_customization.api.sales_order_actions.get_sales_return_print_url",
        args: {
            invoice_name: invoice_name,
            sales_order: frm.doc.name
        },
        callback: function (r) {
            if (r.message && r.message.url) {
                window.open(r.message.url, "_blank");
            }
        }
    });
}

// --- QUICK ITEM SEARCH (Imported from Sales Invoice) ---
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

// Add items table event to calculate on row change
frappe.ui.form.on('Sales Order Item', {
    qty: function (frm, cdt, cdn) {
        calculate_item_values_so(frm, cdt, cdn);
    },

    rate: function (frm, cdt, cdn) {
        calculate_item_values_so(frm, cdt, cdn);
    }
});

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
                    'grant_commission',
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