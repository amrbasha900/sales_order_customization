// ═══════════════════════════════════════════════════════
//  RETURN DIALOG + REUSABLE DIALOG BUILDER
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
    setup_payment_grid_auto_amount(
        dialog,
        "refund_payments",
        () => calculated_grand_total
    );
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
