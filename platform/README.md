# Prototype

A no-build demo of the intake, matching, negotiation-draft and approval flow.

- Open `index.html` in a browser, or run `npx serve .`.
- Run the logic tests: `node test.js`.

What is real: matching, price limits, the approval gate, the activity log.
What is a stub: inventory (mock data), sanctions screening (country list), and message drafting (templates).

To make the drafting use Claude, call the Messages API from a server with the system prompt in `../docs/business-plan.md`, pass it `negotiate()`'s decision (action, price, flags) as the only terms it may express, and keep the approval step. Never put the API key in the browser.
