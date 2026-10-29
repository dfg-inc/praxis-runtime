import { useCallback, useEffect, useState } from 'react';
import { STATUSES } from '../data/orders.js';
import { buildSearch, filterOrders, parseQuery, reconcileOrder } from '../lib/ordersQuery.js';
import { OrderDrawer } from '../components/OrderDrawer.jsx';
import { Button } from '../components/Button.jsx';

export const OrdersPage = ({ orders }) => {
  const [state, setState] = useState(() => parseQuery(window.location.search, orders));

  // Invalid order in the URL is removed without adding a history entry.
  useEffect(() => {
    if (state.normalized) window.history.replaceState(null, '', buildSearch(state) || window.location.pathname);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onPop = () => {
      const next = parseQuery(window.location.search, orders);
      if (next.normalized) window.history.replaceState(null, '', buildSearch(next) || window.location.pathname);
      setState(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [orders]);

  const update = useCallback((next) => {
    setState({ ...next, normalized: false });
    window.history.pushState(null, '', buildSearch(next) || window.location.pathname);
  }, []);

  const setStatus = (value) => {
    const status = value === '' ? null : value;
    update({ status, order: reconcileOrder(orders, status, state.order) });
  };
  const open = (number) => update({ status: state.status, order: number });
  const close = useCallback(() => update({ status: state.status, order: null }), [update, state.status]);

  const visible = filterOrders(orders, state.status);
  const selected = state.order ? orders.find((o) => o.number === state.order) : null;

  return (
    <div className="orders-layout">
      <div className="orders-main">
        <label>Статус{' '}
          <select value={state.status ?? ''} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Все</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <table>
          <thead><tr><th>Number</th><th>Customer</th><th>Status</th></tr></thead>
          <tbody>
            {visible.map((o) => (
              <tr key={o.number} className={o.number === state.order ? 'selected' : ''} onClick={() => open(o.number)}>
                <td>{o.number}</td><td>{o.customer}</td><td>{o.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="empty">Нет заказов со статусом {state.status} <Button onClick={() => setStatus('')}>Сбросить фильтр</Button></p>
        )}
      </div>
      {selected && <OrderDrawer order={selected} onClose={close} />}
    </div>
  );
};
