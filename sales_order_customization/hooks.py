app_name = "sales_order_customization"
app_title = "Sales Order Customization"
app_publisher = "Amr Basha"
app_description = "Customizations for Sales Order flow"
app_email = "amroosama111@gmail.com"
app_license = "mit"

# Includes in <head>
# ------------------
# include js, css files in header of current site
# app_include_css = "/assets/sales_order_customization/css/sales_order_customization.css"
# app_include_js = "/assets/sales_order_customization/js/sales_order_customization.js"

# doctype js
doctype_js = {
    "Sales Order": "public/js/sales_order_custom.js"
}

# Export Custom Fields
fixtures = [
    {"dt": "Custom Field", "filters": [
        [
            "name", "in", [
                "Sales Order Item-custom_last_rate", "Sales Order Item-custom_action", "Company-custom_update_stock",
                 "Company-custom_sales_order_print_format_button", "Sales Order-custom_customer_balance",
                 "Company-custom_print_sales_order_matrix", "Company-custom_sales_order_return_print_format_button",
                 "Company-custom_print_sales_order_return_matrix"
            ]
        ]
    ]}
]
