// ═══════════════════════════════════════════════════════
//  PRINT INVOICE & SALES RETURN LOGIC
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
