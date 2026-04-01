/**
 * Sales Order Customization — Main Entry
 *
 * This file registers Frappe form events for Sales Order and Sales Order Item.
 * All feature logic lives in separate module files loaded before this one:
 *
 *   so_submit_pay.js     — Submit & Pay dialog
 *   so_return.js         — Return dialog + reusable dialog builder
 *   so_item_dashboard.js — Item dashboard (stock/sales/purchase tabs)
 *   so_quick_search.js   — Quick item search, autocomplete, add-to-table
 *   so_offline_sync.js   — IndexedDB offline sync, barcode scanner, recent items
 *   so_print.js          — Print invoice / sales return
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
//  SALES ORDER ITEM EVENTS
// ═══════════════════════════════════════════════════════

frappe.ui.form.on("Sales Order Item", {
    item_code(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        // Skip if item was added from the custom quick search field —
        // all details (rate, uom, qty, etc.) are already set by add_item_to_table_so.
        if (row._added_via_quick_search) {
            delete row._added_via_quick_search;
            return;
        }
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
    },

    qty: function (frm, cdt, cdn) {
        calculate_item_values_so(frm, cdt, cdn);
    },

    rate: function (frm, cdt, cdn) {
        calculate_item_values_so(frm, cdt, cdn);
    }
});

// ═══════════════════════════════════════════════════════
//  ITEM-LEVEL HELPERS (tightly coupled to form events)
// ═══════════════════════════════════════════════════════

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
                        
                        let val_rate_uom = flt(row.valuation_rate) * cf;
                        frappe.model.set_value(cdt, cdn, "valuation_rate_with_uom", val_rate_uom);
                    } else {
                        frappe.model.set_value(cdt, cdn, "actual_qty_in_uom", actual_qty);
                        frappe.model.set_value(cdt, cdn, "valuation_rate_with_uom", flt(row.valuation_rate));
                    }
                }
            },
        });
    }
}

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