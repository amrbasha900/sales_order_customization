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
