export const STATUSES = ['New', 'In progress', 'Shipped', 'Delivered', 'Cancelled'];

// ORD-1990 is a legacy order: it only has number, customer and status.
export const ORDERS = [
  { number: 'ORD-1990', customer: 'Legacy Trading', status: 'Delivered' },
  { number: 'ORD-2001', customer: 'Acme Corp', status: 'New', createdAt: '2026-10-01', total: 1200, email: 'buyer@acme.test', phone: '+1 555 0101', address: '1 Main St, Springfield',
    items: [{ product: 'Widget', quantity: 10, price: 100 }, { product: 'Gadget', quantity: 2, price: 100 }] },
  { number: 'ORD-2002', customer: 'Globex', status: 'In progress', createdAt: '2026-10-02', total: 450, email: 'ops@globex.test', phone: '+1 555 0102', address: '5 Elm Ave, Shelbyville',
    items: [{ product: 'Gizmo', quantity: 3, price: 150 }] },
  { number: 'ORD-2003', customer: 'Initech', status: 'Shipped', createdAt: '2026-10-03', total: 80, email: 'it@initech.test', phone: '+1 555 0103', address: '9 Oak Rd, Capital City',
    items: [{ product: 'Cable', quantity: 4, price: 20 }] },
  { number: 'ORD-2004', customer: 'Umbrella', status: 'In progress', createdAt: '2026-10-04', total: 300, email: 'lab@umbrella.test', phone: '+1 555 0104', address: '2 Pine Ln, Raccoon City',
    items: [{ product: 'Sample kit', quantity: 1, price: 300 }] },
  { number: 'ORD-2005', customer: 'Hooli', status: 'Cancelled', createdAt: '2026-10-05', total: 999, email: 'biz@hooli.test', phone: '+1 555 0105', address: '7 Cedar Blvd, Palo Alto',
    items: [{ product: 'Server', quantity: 1, price: 999 }] },
  { number: 'ORD-2006', customer: 'Stark Industries', status: 'New', createdAt: '2026-10-06', total: 5000, email: 'tony@stark.test', phone: '+1 555 0106', address: '10 Tower Pl, New York',
    items: [{ product: 'Arc reactor', quantity: 1, price: 5000 }] },
  { number: 'ORD-2007', customer: 'Wayne Enterprises', status: 'Delivered', createdAt: '2026-10-07', total: 640, email: 'ops@wayne.test', phone: '+1 555 0107', address: '1 Manor Dr, Gotham',
    items: [{ product: 'Grapple', quantity: 2, price: 320 }] },
];
