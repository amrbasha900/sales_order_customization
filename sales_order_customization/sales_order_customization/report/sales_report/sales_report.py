# Copyright (c) 2026, Amr Basha and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import flt

def execute(filters=None):
	columns = get_columns()
	data = get_data(filters)
	return columns, data

def get_columns():
	return [
		{
			"label": "Sales Invoice",
			"fieldname": "name",
			"fieldtype": "Link",
			"options": "Sales Invoice",
			"width": 150
		},
		{
			"label": "Date",
			"fieldname": "posting_date",
			"fieldtype": "Date",
			"width": 110
		},
		{
			"label": "Customer Name",
			"fieldname": "customer_name",
			"fieldtype": "Data",
			"width": 180
		},
		{
			"label": "Customer",
			"fieldname": "customer",
			"fieldtype": "Link",
			"options": "Customer",
			"width": 130
		},
		{
			"label": "Sales Person",
			"fieldname": "sales_person",
			"fieldtype": "Data",
			"width": 150
		},
		{
			"label": "Sales",
			"fieldname": "sales",
			"fieldtype": "Currency",
			"width": 120
		},
		{
			"label": "Tax",
			"fieldname": "tax",
			"fieldtype": "Currency",
			"width": 120
		},
		{
			"label": "Grand Total",
			"fieldname": "grand_total",
			"fieldtype": "Currency",
			"width": 120
		},
		{
			"label": "Cash",
			"fieldname": "cash",
			"fieldtype": "Currency",
			"width": 120
		},
		{
			"label": "Bank",
			"fieldname": "bank",
			"fieldtype": "Currency",
			"width": 120
		},
		{
			"label": "Credit",
			"fieldname": "outstanding_amount",
			"fieldtype": "Currency",
			"width": 120
		}
	]

def get_data(filters):
	if not filters:
		filters = {}

	filters_list = [["docstatus", "=", 1]]
	
	if filters.get("is_return"):
		is_return_val = 1 if filters.get("is_return") == "Yes" else 0
		filters_list.append(["is_return", "=", is_return_val])
	
	if filters.get("branch"):
		filters_list.append(["branch", "=", filters.get("branch")])
	if filters.get("customer"):
		filters_list.append(["customer", "=", filters.get("customer")])
	if filters.get("from_date"):
		filters_list.append(["posting_date", ">=", filters.get("from_date")])
	if filters.get("to_date"):
		filters_list.append(["posting_date", "<=", filters.get("to_date")])
		
	if filters.get("sales_person"):
		sales_invoices_by_person = frappe.get_all(
			"Sales Team", 
			filters={"sales_person": filters.get("sales_person"), "parenttype": "Sales Invoice"}, 
			pluck="parent"
		)
		if not sales_invoices_by_person:
			return []
		filters_list.append(["name", "in", sales_invoices_by_person])
		
	if filters.get("payment_type"):
		mops = frappe.get_all("Mode of Payment", filters={"type": filters.get("payment_type")}, pluck="name")
		if not mops:
			return []
		payment_entries = frappe.get_all("Payment Entry", filters={"mode_of_payment": ("in", mops), "docstatus": 1}, pluck="name")
		if not payment_entries:
			return []
		paid_invoices = frappe.get_all(
			"Payment Entry Reference", 
			filters={"parent": ("in", payment_entries), "reference_doctype": "Sales Invoice"}, 
			pluck="reference_name"
		)
		if not paid_invoices:
			return []
		filters_list.append(["name", "in", paid_invoices])

	invoices = frappe.get_all(
		"Sales Invoice",
		filters=filters_list,
		fields=[
			"name", 
			"posting_date", 
			"customer_name", 
			"customer", 
			"base_net_total as sales", 
			"total_taxes_and_charges as tax", 
			"grand_total", 
			"outstanding_amount",
			"is_return"
		]
	)
	
	if not invoices:
		return []

	invoice_names = [inv.name for inv in invoices]

	sales_teams = frappe.get_all(
		"Sales Team", 
		filters={"parent": ("in", invoice_names), "parenttype": "Sales Invoice"}, 
		fields=["parent", "sales_person"]
	)
	sp_map = frappe._dict()
	for st in sales_teams:
		sp_map.setdefault(st.parent, []).append(st.sales_person)

	payments = frappe.db.sql("""
		SELECT 
			per.reference_name as parent, per.allocated_amount as amount, mop.type
		FROM 
			`tabPayment Entry Reference` per
		JOIN 
			`tabPayment Entry` pe ON pe.name = per.parent
		JOIN 
			`tabMode of Payment` mop ON mop.name = pe.mode_of_payment
		WHERE 
			per.reference_doctype = 'Sales Invoice'
			AND pe.docstatus = 1
			AND per.reference_name IN %s
	""", (tuple(invoice_names),), as_dict=1)

	payment_map = frappe._dict()
	for p in payments:
		if p.parent not in payment_map:
			payment_map[p.parent] = {"Cash": 0.0, "Bank": 0.0}
		if p.type in ("Cash", "Bank"):
			payment_map[p.parent][p.type] += flt(p.amount)

	data = []
	for inv in invoices:
		row = inv.copy()
		row["sales_person"] = ", ".join(sp_map.get(inv.name, []))
		
		pm = payment_map.get(inv.name, {})
		row["cash"] = pm.get("Cash", 0.0)
		row["bank"] = pm.get("Bank", 0.0)
		
		data.append(row)

	return data
