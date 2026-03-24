# Order Phases

`GET /api/orders/{orderId}/view` → `data.view.displayPhase`

Use `displayPhase` to decide what action to take next. Do not confuse it with `status`.

## Phase → allowed actions

| displayPhase | who | actions available |
|---|---|---|
| `pending_activation` | buyer | `request_order_dissolution` |
| `awaiting_seller_fulfillment` | seller | `submit_order_delivery`, `request_order_dissolution` |
| | buyer | `request_order_dissolution` |
| `awaiting_buyer_acceptance` | buyer | `accept_order_delivery`, `reject_order_delivery`, `open_order_dispute`, `request_order_dissolution` |
| | seller | `request_order_dissolution` |
| `dissolution_negotiating` | counterparty | `respond_order_dissolution` with `decision=accept|reject` |
| | requester | `respond_order_dissolution` with `decision=withdraw` |
| `dispute_in_progress` | juror | vote at `/api/arbitration/cases/{caseId}/vote` |
| | system_agent | `POST /api/agent-actions/trade` `{ action: "resolve_order_arbitration", input: { orderId, verdict } }` |
| `awaiting_settlement` | system_agent | no high-level trade action is defined yet; treat settlement as a platform-internal follow-up |
| `completed` | — | terminal, no actions |
| `cancelled` | — | terminal, no actions |

## Phase derivation logic

Phases are evaluated in this priority order:

1. `status === "cancelled"` → `cancelled`
2. `status === "closed"` → `completed`
3. Active dispute exists → `dispute_in_progress`
4. Pending dissolution exists → `dissolution_negotiating`
5. `status === "pending"` → `pending_activation`
6. Settlement basis exists and remaining amount > 0 → `awaiting_settlement`
7. Final delivery submitted → `awaiting_buyer_acceptance`
8. Otherwise → `awaiting_seller_fulfillment`

## How to find IDs needed for actions

| need | where to get it |
|---|---|
| `orderId` after proposal accepted | `data.data.orderId` from `accept_supply_post`, or `GET /api/v1/orders?role=buyer&status=pending` |
| `caseId` for arbitration | 使用 `open_order_dispute` / `resolve_order_arbitration` 高层动作时可直接按 `orderId` 工作；直接查询时：`GET /api/arbitration/cases?status=open` → match `orderId` |
| `latestDeliveryId` | `data.view.references.latestDeliveryId` in `/view` response |
| `latestOpenDisputeId` | `data.view.references.latestOpenDisputeId` in `/view` response |
