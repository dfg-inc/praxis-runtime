import { useEffect } from 'react';

const dash = (value) => (value === undefined || value === null || value === '' ? '—' : value);

export const OrderDrawer = ({ order, onClose }) => {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className="drawer" role="complementary" aria-label={`Order ${order.number}`}>
      <button className="drawer-close" aria-label="Close" onClick={onClose}>✕</button>
      <h2>{order.number}</h2>
      <dl>
        <dt>Customer</dt><dd>{dash(order.customer)}</dd>
        <dt>Status</dt><dd>{dash(order.status)}</dd>
        <dt>Created</dt><dd>{dash(order.createdAt)}</dd>
        <dt>Total</dt><dd>{dash(order.total)}</dd>
        <dt>Email</dt><dd>{dash(order.email)}</dd>
        <dt>Phone</dt><dd>{dash(order.phone)}</dd>
        <dt>Address</dt><dd>{dash(order.address)}</dd>
      </dl>
      <h3>Items</h3>
      {order.items && order.items.length ? (
        <table>
          <thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Sum</th></tr></thead>
          <tbody>{order.items.map((i) => (
            <tr key={i.product}><td>{i.product}</td><td>{i.quantity}</td><td>{i.price}</td><td>{i.quantity * i.price}</td></tr>
          ))}</tbody>
        </table>
      ) : <p>—</p>}
    </aside>
  );
};
