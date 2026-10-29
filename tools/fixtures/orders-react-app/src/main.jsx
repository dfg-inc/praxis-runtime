import { createRoot } from 'react-dom/client';
import { ORDERS } from './data/orders.js';
import { OrdersPage } from './pages/OrdersPage.jsx';
import './styles/theme.css';

createRoot(document.getElementById('root')).render(<OrdersPage orders={ORDERS} />);
