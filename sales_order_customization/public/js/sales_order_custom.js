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
    },

    refresh(frm) {
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

    customer(frm) {

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
    },

    uom(frm, cdt, cdn) {
        update_last_sales_rate(frm, cdt, cdn);
    },

    custom_action(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row.item_code) {
            frappe.msgprint(__("Please select an Item Code first."));
            return;
        }
        show_item_dashboard_dialog(frm, row);
    }
});

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