# Copyright (c) 2024, Amr Basha and contributors
# License: MIT

import json

import frappe
from frappe import _
from frappe.utils import flt, cint, nowdate


# ──────────────────────────────────────────────────────────
#  FETCH INVOICEABLE ITEMS
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_invoiceable_items(sales_order):
    """Return items from the Sales Order that still have remaining billable qty.

    Remaining Billable Qty = ordered_qty − billed_qty
    (billed_qty is computed from submitted Sales Invoice Items linked via so_detail)
    """
    _validate_sales_order(sales_order)

    so = frappe.get_doc("Sales Order", sales_order)

    # Aggregate billed qty per SO Item from submitted Sales Invoices
    billed_qty_map = _get_billed_qty_map(sales_order)

    rows = []
    for item in so.items:
        billed_qty = flt(billed_qty_map.get(item.name, 0))
        remaining = flt(item.qty) - billed_qty
        if remaining > 0:
            rows.append({
                "so_detail": item.name,
                "item_code": item.item_code,
                "item_name": item.item_name,
                "ordered_qty": flt(item.qty),
                "billed_qty": billed_qty,
                "remaining_qty": remaining,
                "rate": flt(item.rate),
                "amount": flt(remaining * item.rate),
                "warehouse": item.warehouse,
                "uom": item.uom,
            })

    return rows


# ──────────────────────────────────────────────────────────
#  FETCH RETURNABLE ITEMS
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_returnable_items(sales_order):
    """Return items that were already invoiced and are still eligible for return.

    Grouped by source Sales Invoice so the client can display which
    invoice each line belongs to.

    Returnable Qty = invoiced_qty − already_returned_qty
    Already-returned qty comes from submitted Credit Notes where
    return_against = <source SI> and sales_invoice_item matches.
    """
    _validate_sales_order(sales_order)

    # Step 1: Get all submitted Sales Invoice Items linked to this SO
    si_items = frappe.db.sql("""
        SELECT
            sii.name           AS si_item_name,
            sii.parent         AS sales_invoice,
            si.posting_date    AS invoice_date,
            sii.item_code,
            sii.item_name,
            sii.qty            AS invoiced_qty,
            sii.rate,
            sii.so_detail,
            sii.warehouse,
            sii.uom
        FROM `tabSales Invoice Item` sii
        INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.sales_order = %(so)s
          AND si.docstatus = 1
          AND si.is_return = 0
    """, {"so": sales_order}, as_dict=True)

    if not si_items:
        return []

    # Step 2: Get already-returned qty per (sales_invoice, sales_invoice_item)
    returned_qty_map = _get_returned_qty_map(sales_order)

    rows = []
    for item in si_items:
        key = (item.sales_invoice, item.si_item_name)
        already_returned = flt(returned_qty_map.get(key, 0))
        remaining = flt(item.invoiced_qty) - already_returned
        if remaining > 0:
            rows.append({
                "sales_invoice": item.sales_invoice,
                "invoice_date": str(item.invoice_date) if item.invoice_date else "",
                "si_item_name": item.si_item_name,
                "so_detail": item.so_detail,
                "item_code": item.item_code,
                "item_name": item.item_name,
                "invoiced_qty": flt(item.invoiced_qty),
                "already_returned_qty": already_returned,
                "remaining_qty": remaining,
                "rate": flt(item.rate),
                "amount": flt(remaining * item.rate),
                "warehouse": item.warehouse,
                "uom": item.uom,
            })

    return rows


# ──────────────────────────────────────────────────────────
#  CREATE SALES INVOICE
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def create_sales_invoice(args):
    """Create a Sales Invoice from selected Sales Order items.

    Args (JSON string or dict):
        sales_order       : str   – Sales Order name
        items             : list  – [{so_detail, qty}, …]
        submit            : bool  – auto-submit the invoice
        create_payment    : bool  – create and submit a Payment Entry
        mode_of_payment   : str   – required when create_payment is True
    """
    args = _parse_args(args)

    sales_order = args.get("sales_order")
    items = args.get("items") or []
    submit = cint(args.get("submit"))
    create_payment = cint(args.get("create_payment"))
    mode_of_payment = args.get("mode_of_payment")

    # ── Validations ────────────────────────────────
    _validate_sales_order(sales_order)

    if not items:
        frappe.throw(_("Please select at least one item to invoice."))

    if create_payment and not mode_of_payment:
        frappe.throw(_("Mode of Payment is required when creating a Payment Entry."))

    so = frappe.get_doc("Sales Order", sales_order)
    company_update_stock = frappe.db.get_value("Company", so.company, "custom_update_stock")
    billed_qty_map = _get_billed_qty_map(sales_order)

    # Validate each selected item
    selected_so_details = []
    qty_map = {}  # so_detail → qty_to_invoice
    for row in items:
        so_detail = row.get("so_detail")
        qty_to_invoice = flt(row.get("qty"))

        if qty_to_invoice <= 0:
            frappe.throw(_("Qty to Invoice must be greater than zero for item row {0}.").format(so_detail))

        # Find the SO item
        so_item = _find_so_item(so, so_detail)
        billed_qty = flt(billed_qty_map.get(so_detail, 0))
        remaining = flt(so_item.qty) - billed_qty

        if qty_to_invoice > remaining:
            frappe.throw(
                _("Row {0}: Qty to Invoice ({1}) exceeds Remaining Billable Qty ({2}) for {3}.").format(
                    so_item.idx, qty_to_invoice, remaining, so_item.item_code
                )
            )

        selected_so_details.append(so_detail)
        qty_map[so_detail] = qty_to_invoice

    # ── Create Sales Invoice using ERPNext's standard mapper ──
    from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice

    si = make_sales_invoice(
        sales_order,
        args={"filtered_children": selected_so_details},
    )

    # Override qty to match user-selected partial quantities
    items_to_remove = []
    for si_item in si.items:
        so_detail = si_item.so_detail
        if so_detail in qty_map:
            si_item.qty = qty_map[so_detail]
            si_item.amount = flt(si_item.qty * si_item.rate)
            si_item.base_amount = flt(si_item.amount * (so.conversion_rate or 1))
        else:
            items_to_remove.append(si_item)

    for item in items_to_remove:
        si.items.remove(item)

    si.update_stock = cint(company_update_stock)
    si.set_missing_values()
    si.calculate_taxes_and_totals()
    si.insert(ignore_permissions=False)

    result = {"sales_invoice": si.name}

    if submit:
        si.submit()
        result["submitted"] = True

    # ── Optional Payment Entry ─────────────────────
    if create_payment and submit:
        pe = _create_payment_entry(si.name, mode_of_payment)
        result["payment_entry"] = pe.name

    frappe.db.commit()
    return result


# ──────────────────────────────────────────────────────────
#  AUTO-CREATE INVOICE + PAYMENT ON SO SUBMIT & PAY
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def auto_create_invoice_and_payment(sales_order, payments, create_without_payment=0):
    """
    1. Create & Submit Sales Invoice for ALL items in the Sales Order
    2. Optional: Create & Submit Payment Entries for the given payments

    args:
        sales_order : str 
        payments    : list of dicts: [
            {"mode_of_payment": "Cash", "amount": 100, "reference_no": "...", "reference_date": "..."},
            ...
        ]
        create_without_payment: int (1 or 0) - if 1, skips payment validations and creation
    """
    if isinstance(payments, str):
        payments = json.loads(payments)

    if not sales_order:
        frappe.throw(_("Sales Order is required."))

    so = frappe.get_doc("Sales Order", sales_order)
    company_update_stock = frappe.db.get_value("Company", so.company, "custom_update_stock")

    if so.docstatus == 0:
        so.submit()
    elif so.docstatus == 2:
        frappe.throw(_("Sales Order {0} is cancelled.").format(sales_order))
        
    create_without_payment = cint(create_without_payment)

    total_payment = 0
    if payments:
        # Validate each payment row has a mode_of_payment and positive amount
        for idx, p in enumerate(payments, 1):
            if not p.get("mode_of_payment"):
                frappe.throw(_("Row {0}: Mode of Payment is required.").format(idx))
            if flt(p.get("amount")) <= 0:
                frappe.throw(_("Row {0}: Amount must be greater than zero.").format(idx))
            total_payment += flt(p.get("amount"))

    # ── Create Sales Invoice for ALL items ─────────
    from erpnext.selling.doctype.sales_order.sales_order import make_sales_invoice

    si = make_sales_invoice(sales_order)
    si.update_stock = cint(company_update_stock)
    si.set_missing_values()
    si.calculate_taxes_and_totals()
    si.insert(ignore_permissions=False)
    si.submit()

    # ── Validation of total payment vs invoice grand total ──
    if not create_without_payment:
        # Strict equality when NOT creating without payment
        if flt(total_payment, 2) != flt(si.grand_total, 2):
            frappe.throw(
                _("Total payment amount ({0}) must match Invoice Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(si.grand_total, {"fieldtype": "Currency"}),
                )
            )
    else:
        # Partial allowed when creating without payment, but cannot EXCEED
        if flt(total_payment, 2) > flt(si.grand_total, 2):
            frappe.throw(
                _("Total payment amount ({0}) cannot exceed Invoice Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(si.grand_total, {"fieldtype": "Currency"}),
                )
            )

    payment_entries = []
    
    # ── Create Payment Entries (one per payment row) if any ──
    if payments:
        for p in payments:
            pe = _create_payment_entry(
                si.name,
                p.get("mode_of_payment"),
                paid_amount=flt(p.get("amount")),
                reference_no=p.get("reference_no"),
                reference_date=p.get("reference_date"),
            )
            payment_entries.append(pe.name)

    frappe.db.commit()

    return {
        "sales_invoice": si.name,
        "payment_entries": payment_entries,
    }


@frappe.whitelist()
def calculate_return_totals(args):
    """Simulate return creation to calculate grand totals (including taxes)."""
    args = _parse_args(args)
    items = args.get("items") or []
    if not items:
        return {"total_grand_total": 0.0}

    # Group items by Sales Invoice
    si_groups = {}
    for row in items:
        si_groups.setdefault(row.get("sales_invoice"), []).append(row)

    from erpnext.controllers.sales_and_purchase_return import make_return_doc
    total_grand_total = 0.0

    for si_name, si_items in si_groups.items():
        try:
            return_doc = make_return_doc("Sales Invoice", si_name)
            si_item_qty_map = {r["si_item_name"]: flt(r["qty"]) for r in si_items}

            items_to_keep = []
            for ret_item in return_doc.items:
                orig_si_item = ret_item.sales_invoice_item
                if orig_si_item in si_item_qty_map:
                    ret_item.qty = -1 * si_item_qty_map[orig_si_item]
                    items_to_keep.append(ret_item)
            
            return_doc.items = items_to_keep
            return_doc.run_method("calculate_taxes_and_totals")
            # For returns, grand_total is typically negative in ERPNext
            total_grand_total += abs(flt(return_doc.grand_total))
        except Exception:
            # If make_return_doc fails for one SI, skip it in calculation
            continue

    return {"total_grand_total": total_grand_total}


@frappe.whitelist()
def create_sales_return(args):
    """Create Credit Note(s) from selected invoiced items."""
    args = _parse_args(args)

    sales_order = args.get("sales_order")
    items = args.get("items") or []
    submit = cint(args.get("submit"))
    create_without_refund = cint(args.get("create_without_refund"))
    return_reason = args.get("return_reason") or ""
    payments = args.get("payments") or []

    # ── Validations ────────────────────────────────
    _validate_sales_order(sales_order)
    so_company = frappe.db.get_value("Sales Order", sales_order, "company")
    company_update_stock = frappe.db.get_value("Company", so_company, "custom_update_stock")

    if not items:
        frappe.throw(_("Please select at least one item to return."))

    if not return_reason:
        frappe.throw(_("Return Reason is required."))

    total_payment = 0
    if payments:
        for idx, p in enumerate(payments, 1):
            if not p.get("mode_of_payment"):
                frappe.throw(_("Refund Row {0}: Mode of Payment is required.").format(idx))
            if flt(p.get("amount")) <= 0:
                frappe.throw(_("Refund Row {0}: Amount must be greater than zero.").format(idx))
            total_payment += flt(p.get("amount"))

    returned_qty_map = _get_returned_qty_map(sales_order)

    # Group selected items by source Sales Invoice
    si_groups = {}
    for row in items:
        si_name = row.get("sales_invoice")
        si_item_name = row.get("si_item_name")
        qty_to_return = flt(row.get("qty"))

        if qty_to_return <= 0:
            frappe.throw(_("Qty to Return must be greater than zero."))

        # Validate against remaining returnable qty
        si_item_doc = frappe.get_doc("Sales Invoice Item", si_item_name)
        key = (si_name, si_item_name)
        already_returned = flt(returned_qty_map.get(key, 0))
        remaining = flt(si_item_doc.qty) - already_returned

        if qty_to_return > remaining:
            frappe.throw(
                _("Qty to Return ({0}) exceeds Remaining Returnable Qty ({1}) for item {2} in {3}.").format(
                    qty_to_return, remaining, si_item_doc.item_code, si_name
                )
            )

        si_groups.setdefault(si_name, []).append({
            "si_item_name": si_item_name,
            "item_code": si_item_doc.item_code,
            "qty": qty_to_return,
            "rate": flt(si_item_doc.rate),
        })

    # ── Create one Credit Note per source Sales Invoice ──
    from erpnext.controllers.sales_and_purchase_return import make_return_doc

    result = {"returns": [], "payment_entries": []}
    total_grand_total = 0.0

    for si_name, si_items in si_groups.items():
        # Build the return qty map for filtering
        si_item_qty_map = {r["si_item_name"]: r["qty"] for r in si_items}

        # Use ERPNext's standard make_return_doc to create a return
        return_doc = make_return_doc("Sales Invoice", si_name)

        # Filter to only the selected items and adjust qty
        items_to_keep = []
        for ret_item in return_doc.items:
            orig_si_item = ret_item.sales_invoice_item
            if orig_si_item in si_item_qty_map:
                # make_return_doc sets qty as negative; we override with user qty
                ret_item.qty = -1 * flt(si_item_qty_map[orig_si_item])
                ret_item.amount = flt(ret_item.qty * ret_item.rate)
                if hasattr(ret_item, 'stock_qty'):
                    ret_item.stock_qty = flt(ret_item.qty * (ret_item.conversion_factor or 1))
                items_to_keep.append(ret_item)

        return_doc.items = items_to_keep

        # Set return reason (ZATCA custom field)
        return_doc.custom_return_reason = return_reason

        # Set additional ZATCA references (Table MultiSelect)
        return_doc.set("custom_return_against_additional_references", [])
        return_doc.append("custom_return_against_additional_references", {
            "sales_invoice": si_name,
        })

        return_doc.update_stock = cint(company_update_stock)
        return_doc.run_method("calculate_taxes_and_totals")
        return_doc.insert(ignore_permissions=False)

        if submit:
            return_doc.submit()

        result["returns"].append(return_doc.name)
        total_grand_total += abs(flt(return_doc.grand_total))

    # ── Validation of total payment vs return grand totals ──
    if not create_without_refund:
        if flt(total_payment, 2) != flt(total_grand_total, 2):
            frappe.throw(
                _("Total refund amount ({0}) must match Returns Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(total_grand_total, {"fieldtype": "Currency"}),
                )
            )
    else:
        if flt(total_payment, 2) > flt(total_grand_total, 2):
            frappe.throw(
                _("Total refund amount ({0}) cannot exceed Returns Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(total_grand_total, {"fieldtype": "Currency"}),
                )
            )

    # ── Optional Refund Payment Entries ────────
    if total_payment > 0:
        # Multi-return case: distribute payments
        remaining_payments = payments[:]
        for return_name in result["returns"]:
            if not remaining_payments:
                break
            
            return_doc = frappe.get_doc("Sales Invoice", return_name)
            available_to_refund = abs(flt(return_doc.grand_total))
            
            new_remaining = []
            for p in remaining_payments:
                if available_to_refund <= 0:
                    new_remaining.append(p)
                    continue
                
                amount_to_pay = min(flt(p.get("amount")), available_to_refund)
                if amount_to_pay > 0:
                    pe = _create_payment_entry(
                        return_doc.name,
                        p.get("mode_of_payment"),
                        paid_amount=amount_to_pay,
                        reference_no=p.get("reference_no"),
                        reference_date=p.get("reference_date"),
                    )
                    result["payment_entries"].append(pe.name)
                    available_to_refund -= amount_to_pay
                    p["amount"] = flt(p["amount"]) - amount_to_pay
                
                if flt(p.get("amount", 0)) > 0:
                    new_remaining.append(p)
            
            remaining_payments = new_remaining

    frappe.db.commit()
    return result


# ──────────────────────────────────────────────────────────
#  GET LAST SALES RATE
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_last_sales_rate(customer, item_code, uom=None):
    """Return the rate from the most recent submitted Sales Order for this customer and item, matching UOM."""
    if not customer or not item_code:
        return 0.0
        
    query = """
        SELECT
            sii.rate
        FROM `tabSales Order Item` sii
        INNER JOIN `tabSales Order` so ON so.name = sii.parent
        WHERE so.customer = %(customer)s
          AND sii.item_code = %(item_code)s
          AND so.docstatus = 1
    """
    
    params = {
        "customer": customer,
        "item_code": item_code
    }
    
    if uom:
        query += " AND sii.uom = %(uom)s"
        params["uom"] = uom
        
    query += " ORDER BY so.transaction_date DESC, so.creation DESC LIMIT 1"
    
    rate = frappe.db.sql(query, params)
    
    return flt(rate[0][0]) if rate else 0.0


# ──────────────────────────────────────────────────────────
#  PRINT INVOICE API
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_sales_invoice_print_url(sales_order):
    """Get the print URL for the connected Sales Invoice using the format defined in the Company."""
    so_doc = frappe.get_doc("Sales Order", sales_order)
    
    # 1. Find the Sales Invoice that's linked to this Sales Order
    si_name = frappe.db.sql('''
        SELECT parent 
        FROM `tabSales Invoice Item` 
        WHERE sales_order = %(so)s AND docstatus = 1
        LIMIT 1
    ''', {"so": sales_order})
    
    if not si_name:
        frappe.throw(_("No valid Sales Invoice found for this Sales Order."))
        
    si_name = si_name[0][0]
    
    # 2. Check the company configuration for the print format and matrix toggle
    settings = frappe.db.get_value("Company", so_doc.company, 
        ["custom_sales_order_print_format_button", "custom_print_sales_order_matrix"], as_dict=True)
    
    print_format = settings.get("custom_sales_order_print_format_button")
    use_matrix = settings.get("custom_print_sales_order_matrix")
    
    if not print_format:
        frappe.throw(_("Print Format not configured in Company {0}. Please set 'Sales Order Print Format Button' in the Company record.").format(so_doc.company))

    # 3. Build the URL
    from urllib.parse import urlencode
    
    if use_matrix:
        params = {
            "doctype": "Sales Invoice",
            "name": si_name,
            "trigger_print": 1,
            "format": print_format,
            "no_letterhead": 1,
            "letterhead": "No Letterhead",
            "settings": "{}",
            "_lang": "en"
        }
        url = f"/printview?{urlencode(params)}"
    else:
        params = {
            "doctype": "Sales Invoice",
            "name": si_name,
            "format": print_format
        }
        url = f"/api/method/frappe.utils.print_format.download_pdf?{urlencode(params)}"
        
    return {"url": url}

@frappe.whitelist()
def get_sales_returns(sales_order):
    """Return a list of submitted Sales Invoices that are returns for this Sales Order."""
    if not sales_order:
        return []

    return frappe.db.sql("""
        SELECT DISTINCT
            si.name,
            si.posting_date
        FROM `tabSales Invoice` si
        INNER JOIN `tabSales Invoice Item` sii ON sii.parent = si.name
        WHERE sii.sales_order = %(so)s
          AND si.is_return = 1
          AND si.docstatus = 1
        ORDER BY si.posting_date DESC, si.creation DESC
    """, {"so": sales_order}, as_dict=True)

@frappe.whitelist()
def get_sales_return_print_url(invoice_name, sales_order):
    """Get the print URL for a specific Sales Return invoice."""
    so_doc = frappe.get_doc("Sales Order", sales_order)
    
    # Check the company configuration for the print format and matrix toggle
    settings = frappe.db.get_value("Company", so_doc.company, 
        ["custom_sales_order_return_print_format_button", "custom_print_sales_order_return_matrix"], as_dict=True)
    
    print_format = settings.get("custom_sales_order_return_print_format_button")
    use_matrix = settings.get("custom_print_sales_order_return_matrix")
    
    if not print_format:
        frappe.throw(_("Print Format not configured in Company {0}.").format(so_doc.company))

    from urllib.parse import urlencode
    
    if use_matrix:
        params = {
            "doctype": "Sales Invoice",
            "name": invoice_name,
            "trigger_print": 1,
            "format": print_format,
            "no_letterhead": 1,
            "letterhead": "No Letterhead",
            "settings": "{}",
            "_lang": "en"
        }
        url = f"/printview?{urlencode(params)}"
    else:
        params = {
            "doctype": "Sales Invoice",
            "name": invoice_name,
            "format": print_format
        }
        url = f"/api/method/frappe.utils.print_format.download_pdf?{urlencode(params)}"
        
    return {"url": url}

# ──────────────────────────────────────────────────────────
#  GET ITEM HISTORY FOR ACTION BUTTON
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_item_warehouse_data(item_code, company=None):
    """Return warehouse stock data for a specific item (alternative to standard dashboard API)."""
    if not item_code:
        return []
    
    conditions = "item_code = %(item_code)s"
    # To handle cases where company is provided but might not be relevant to bin directly without join
    # Bin typically has a warehouse field, and Warehouse has a company field.
    
    sql = """
        SELECT
            b.warehouse as warehouse_name,
            b.actual_qty,
            b.projected_qty,
            b.reserved_qty
        FROM `tabBin` b
        WHERE b.item_code = %(item_code)s
    """
    
    if company:
        sql += " AND EXISTS (SELECT name FROM `tabWarehouse` w WHERE w.name = b.warehouse AND w.company = %(company)s)"
        
    sql += " ORDER BY b.actual_qty DESC"

    return frappe.db.sql(sql, {
        "item_code": item_code,
        "company": company
    }, as_dict=True)

@frappe.whitelist()
def get_item_sales_history(item_code, limit=5, start=0):
    """Return recent sales history for a specific item across all customers."""
    if not item_code:
        return []

    return frappe.db.sql("""
        SELECT
            si.posting_date,
            sii.parent AS invoice_name,
            si.customer,
            sii.rate,
            sii.qty,
            sii.uom,
            sii.amount
        FROM `tabSales Invoice Item` sii
        INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.item_code = %(item_code)s
          AND si.docstatus = 1
        ORDER BY si.posting_date DESC, si.creation DESC
        LIMIT %(limit)s OFFSET %(start)s
    """, {
        "item_code": item_code,
        "limit": cint(limit),
        "start": cint(start)
    }, as_dict=True)

@frappe.whitelist()
def get_item_purchase_history(item_code, limit=5, start=0):
    """Return recent purchase history for a specific item across all suppliers."""
    if not item_code:
        return []

    return frappe.db.sql("""
        SELECT
            pi.posting_date,
            pii.parent AS invoice_name,
            pi.supplier,
            pii.rate,
            pii.qty,
            pii.uom,
            pii.amount
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
        WHERE pii.item_code = %(item_code)s
          AND pi.docstatus = 1
        ORDER BY pi.posting_date DESC, pi.creation DESC
        LIMIT %(limit)s OFFSET %(start)s
    """, {
        "item_code": item_code,
        "limit": cint(limit),
        "start": cint(start)
    }, as_dict=True)

# ──────────────────────────────────────────────────────────
#  INTERNAL HELPERS
# ──────────────────────────────────────────────────────────

def _validate_sales_order(sales_order):
    """Common pre-checks for the Sales Order."""
    if not sales_order:
        frappe.throw(_("Sales Order is required."))

    so = frappe.get_doc("Sales Order", sales_order)

    # Permission check
    if not frappe.has_permission("Sales Order", "read", so):
        frappe.throw(_("You do not have permission to access this Sales Order."), frappe.PermissionError)

    # Docstatus check – must be submitted
    if so.docstatus != 1:
        frappe.throw(_("Sales Order {0} must be submitted before creating invoices or returns.").format(sales_order))

    # Status check – must not be cancelled or closed
    if so.status in ("Cancelled", "Closed"):
        frappe.throw(_("Cannot create documents against a {0} Sales Order.").format(so.status))


def _find_so_item(so, so_detail):
    """Find a Sales Order Item row by its name."""
    for item in so.items:
        if item.name == so_detail:
            return item
    frappe.throw(_("Sales Order Item {0} not found.").format(so_detail))


def _get_billed_qty_map(sales_order):
    """Return {so_detail: billed_qty} from submitted Sales Invoices (excluding returns)."""
    data = frappe.db.sql("""
        SELECT
            sii.so_detail,
            SUM(sii.qty) AS billed_qty
        FROM `tabSales Invoice Item` sii
        INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.sales_order = %(so)s
          AND si.docstatus = 1
          AND si.is_return = 0
        GROUP BY sii.so_detail
    """, {"so": sales_order}, as_dict=True)

    return {d.so_detail: flt(d.billed_qty) for d in data}


def _get_returned_qty_map(sales_order):
    """Return {(sales_invoice, si_item_name): abs(returned_qty)} from submitted Credit Notes.

    We look at submitted Sales Invoices that are returns (is_return=1),
    whose return_against is a Sales Invoice linked to this Sales Order.
    """
    data = frappe.db.sql("""
        SELECT
            ret_item.sales_invoice_item,
            si_orig.name AS original_invoice,
            SUM(ABS(ret_item.qty)) AS returned_qty
        FROM `tabSales Invoice Item` ret_item
        INNER JOIN `tabSales Invoice` ret_si ON ret_si.name = ret_item.parent
        INNER JOIN `tabSales Invoice` si_orig ON si_orig.name = ret_si.return_against
        INNER JOIN `tabSales Invoice Item` orig_item
            ON orig_item.name = ret_item.sales_invoice_item
            AND orig_item.parent = si_orig.name
        WHERE orig_item.sales_order = %(so)s
          AND ret_si.docstatus = 1
          AND ret_si.is_return = 1
        GROUP BY ret_item.sales_invoice_item, si_orig.name
    """, {"so": sales_order}, as_dict=True)

    return {
        (d.original_invoice, d.sales_invoice_item): flt(d.returned_qty)
        for d in data
    }


def _create_payment_entry(sales_invoice_name, mode_of_payment,
                           paid_amount=None, reference_no=None, reference_date=None):
    """Create and submit a Payment Entry for the given Sales Invoice.

    Uses ERPNext's standard get_payment_entry which handles:
    - party account resolution
    - bank/cash account resolution from mode_of_payment
    - outstanding amount calculation
    - references table population

    When paid_amount is provided, the PE amount is overridden (for multi-mode splits).
    """
    from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
    from erpnext.accounts.doctype.journal_entry.journal_entry import get_default_bank_cash_account

    si = frappe.get_doc("Sales Invoice", sales_invoice_name)

    # Resolve the bank/cash account from Mode of Payment
    bank_account_info = get_default_bank_cash_account(
        si.company, account_type=None, mode_of_payment=mode_of_payment
    )

    bank_account = bank_account_info.get("account") if bank_account_info else None

    pe = get_payment_entry(
        dt="Sales Invoice",
        dn=sales_invoice_name,
        bank_account=bank_account,
    )

    pe.mode_of_payment = mode_of_payment

    # Override amount for multi-mode payment splits
    if paid_amount is not None and flt(paid_amount) > 0:
        paid_amount = flt(paid_amount)
        pe.paid_amount = paid_amount
        pe.received_amount = paid_amount
        pe.base_paid_amount = flt(paid_amount * flt(pe.source_exchange_rate, 1.0))
        pe.base_received_amount = flt(paid_amount * flt(pe.target_exchange_rate, 1.0))
        pe.unallocated_amount = 0

        # Update the reference allocated amount
        if pe.references:
            # For returns (Credit Notes), the allocated amount is negative
            if getattr(si, "is_return", 0):
                pe.references[0].allocated_amount = -paid_amount
            else:
                pe.references[0].allocated_amount = paid_amount


    # Set optional reference fields
    if reference_no:
        pe.reference_no = reference_no
    if reference_date:
        pe.reference_date = reference_date

    # Re-resolve account if bank account was resolved
    if bank_account:
        if pe.payment_type == "Receive":
            pe.paid_to = bank_account
            pe.paid_to_account_currency = bank_account_info.get("account_currency")
        else:
            pe.paid_from = bank_account
            pe.paid_from_account_currency = bank_account_info.get("account_currency")

    pe.insert(ignore_permissions=False)
    pe.submit()

    return pe


def _parse_args(args):
    """Parse JSON args if passed as a string."""
    if isinstance(args, str):
        args = json.loads(args)
    return frappe._dict(args)

from erpnext.selling.doctype.customer.customer import get_customer_outstanding
@frappe.whitelist()  
def get_customer_outstanding_amount(customer, company, ignore_outstanding_sales_order=False, cost_center=None):
    return get_customer_outstanding(customer, company, ignore_outstanding_sales_order, cost_center)