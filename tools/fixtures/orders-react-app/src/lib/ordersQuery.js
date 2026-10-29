import { STATUSES } from '../data/orders.js';

// Unknown or empty status means "all" (REQ-ORD-004-AC-05).
export const normalizeStatus = (value) => (STATUSES.includes(value) ? value : null);

export const filterOrders = (orders, status) => (status ? orders.filter((o) => o.status === status) : orders);

// Reads status/order from a query string. An order that does not exist or is
// outside the selected filter is dropped (REQ-ORD-004-AC-06).
export const parseQuery = (search, orders) => {
  const params = new URLSearchParams(search);
  const status = normalizeStatus(params.get('status'));
  const requested = params.get('order');
  const visible = filterOrders(orders, status);
  const order = requested && visible.some((o) => o.number === requested) ? requested : null;
  return { status, order, normalized: requested !== null && order === null };
};

// Builds the query string; "all" has no status parameter (REQ-ORD-004-AC-01).
export const buildSearch = ({ status, order }) => {
  const parts = [];
  if (status) parts.push(`status=${encodeURIComponent(status)}`);
  if (order) parts.push(`order=${encodeURIComponent(order)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

// Filter change keeps the open order only if it is still listed (REQ-ORD-003).
export const reconcileOrder = (orders, status, order) =>
  order && filterOrders(orders, status).some((o) => o.number === order) ? order : null;
