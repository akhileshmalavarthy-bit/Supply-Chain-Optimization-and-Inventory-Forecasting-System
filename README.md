# Supply Chain Optimization and Inventory Forecasting System

A web-based dashboard prototype for tracking inventory, forecasting product demand, monitoring supplier performance, and recommending when to reorder stock.

## Problem Statement

Businesses need to know how much stock they have, how much customers may buy, and when to place replenishment orders. Poor inventory decisions can lead to:

- **Stockouts:** products become unavailable and sales may be lost.
- **Excess inventory:** money is tied up in products that sell slowly, and storage costs may increase.
- **Late supplier deliveries:** delays can cause stock shortages.
- **Manual guesswork:** spreadsheets and estimates can lead to inaccurate records and poor decisions.

This project brings inventory tracking and demand-planning information together in one dashboard to support better, data-driven decisions.

## Objectives

- Track stock levels for each product.
- Estimate demand using historical sales data.
- Calculate reorder points automatically.
- Monitor supplier delivery performance.
- Display understandable stock alerts and reorder recommendations.

## Features

- **Dashboard:** key performance indicators and demand/supplier charts.
- **Product management:** add, edit, delete, search, and sort products.
- **Inventory ledger:** record stock movements as `IN`, `OUT`, or `ADJUST`.
- **Demand forecasting:** display a forecast for the next 14 days.
- **Low-stock alerts:** show stock status using red, amber, and green indicators.
- **Recommendations:** provide reorder guidance with explanations and CSV export.

## Technology Stack

### Current prototype

- HTML5 — page structure
- CSS3 — styling and responsive presentation
- JavaScript — application logic and calculations
- Chart.js — charts and graphs

### Planned next stage

- Python with Flask — backend and REST APIs
- SQL database — persistent storage
- scikit-learn and/or statsmodels — advanced forecasting

> **Implementation status:** The current prototype runs in the browser and uses sample/in-memory data. Flask, a SQL database, and advanced forecasting libraries are planned for a future stage; do not describe them as implemented unless they have been added separately.

## How It Works

1. Product and supplier information is displayed in the dashboard.
2. Inventory transactions record stock entering, leaving, or being adjusted.
3. Historical demand is used to estimate demand for the next 14 days.
4. The system calculates reorder points using demand, supplier lead time, and safety stock.
5. Low-stock alerts and recommendations help users decide which products may need replenishment.

### Reorder Point Formula

```text
Reorder Point = (Average Daily Demand × Lead Time in Days) + Safety Stock
```

**Example**

If average daily demand is 20 units, supplier lead time is 5 days, and safety stock is 30 units:

```text
Reorder Point = (20 × 5) + 30
              = 130 units
```

When stock reaches or falls below this level, the product should be considered for reorder.

### Stock Calculation

```text
Current Stock = Opening Stock + IN − OUT + Adjustments
```

The inventory ledger is used as the source for calculating stock balance.

## Data Model (Planned SQL Design)

The proposed relational database contains:

- **SUPPLIERS:** supplier details.
- **PRODUCTS:** SKU, name, unit cost, lead time, safety stock, reorder point, opening stock, and supplier reference.
- **PURCHASE_ORDERS:** supplier/product references, quantity, order date, expected and received dates, and status.
- **TRANSACTIONS:** product reference, date, transaction type, quantity, and note.
- **DEMAND_HISTORY:** product reference, date, and units sold.

Primary keys (PK) uniquely identify records. Foreign keys (FK) link related records between tables.

## Proposed REST API (Planned Flask Backend)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/products` | List products with stock status |
| POST | `/api/products` | Add a product |
| PUT | `/api/products/<id>` | Edit a product |
| DELETE | `/api/products/<id>` | Remove a product |
| POST | `/api/transactions` | Record an IN, OUT, or ADJUST transaction |
| GET | `/api/analytics/forecast` | Retrieve the 14-day demand forecast |
| GET | `/api/recommendations` | Retrieve reorder and risk recommendations |

These endpoints are proposed for the future Flask version; the current browser prototype does not necessarily expose them.

## Running the Current Prototype

The project presentation describes a browser-based HTML/CSS/JavaScript prototype. If the project folder contains an HTML entry file:

1. Download or clone the project repository.
2. Open the project folder.
3. Open the main HTML file (often `index.html`) in a modern browser.

If the project uses local assets or requires a local web server, follow the setup instructions included in that project folder. The source-code folder was not provided here, so the exact entry filename and dependency setup cannot be confirmed.

## Sample Data

The prototype presentation describes sample data consisting of:

- 10 products
- 5 suppliers
- 14 purchase orders
- 90 days of demand history

These figures describe the sample data used in the prototype, not necessarily live business data.

## Limitations

- The current version is a prototype that uses sample data in the browser.
- A persistent SQL database and Flask backend are planned for the next stage.
- Forecast quality depends on the quality and amount of historical data.
- Recommendations support decision-making; the prototype does not automatically place purchase orders.

## Future Enhancements

- Add a Flask backend and persistent SQL database.
- Improve forecasting with scikit-learn or statsmodels.
- Support purchase-order creation and supplier follow-up.
- Add email and mobile alerts for low stock.
- Add user login and role-based access.

## Team

- Narasimha
- Akhilesh
- Yuvaraj
- Shaheen

**Institution:** Mohan Babu University (MBU)

## License

No license information was provided. Add a license file if you intend to distribute or publish this project.
