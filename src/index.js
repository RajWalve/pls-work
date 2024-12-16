require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const app = express();

// Configure express-session middleware
app.use(session({
  secret: 'super-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' } // Set to true in production
}));

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'htmlFiles')));
app.use('/css', express.static(path.join(__dirname, '..', 'cssFiles')));
app.use('/content', express.static(path.join(__dirname, '..', 'content')));

// Body parser middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // Ensure you can parse JSON bodies

// Create MySQL connection pool
const db = mysql.createPool({
  host: process.env.DB_HOST, 
  user: process.env.DB_USER,  
  password: process.env.DB_PASS,  
  database: process.env.DB_NAME,  
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});



// Global variable to hold allowed tables
let allowedTables = [];

// Function to initialize allowed tables
async function initializeAllowedTables() {
  try {
    const [tables] = await db.query('SHOW TABLES');
    allowedTables = tables.map(table => Object.values(table)[0]);
  } catch (err) {
    console.error('Error initializing allowed tables:', err);
  }
}

// Initialize allowed tables on server start
initializeAllowedTables();

// Serve the home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'htmlFiles', 'homePage.html'));
});

// API to fetch products based on category
app.get('/api/products', async (req, res) => {
  const category = req.query.category;

  if (!category) {
    return res.status(400).json({ error: 'Category is required' });
  }

  try {
    const [results] = await db.query('SELECT * FROM products WHERE category = ?', [category]);
    res.json(results);
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).json({ error: 'Database query error' });
  }
});

// Login route
app.post('/login', async (req, res) => {
  const { login, password } = req.body;  // Accept both username or email in 'login'

  if (!login || !password) {
    return res.status(400).send('Missing username or password');
  }

  try {
    // Hardcoded admin check
    if (login === 'admin' && password === 'admin') {
      req.session.userId = null; 
      req.session.username = 'admin'; 
      return res.redirect('/adminPage.html');  
    }

    // Check if login is a username or email in the database
    const [rows] = await db.execute(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [login, login]  // Using same variable for both username and email
    );

    if (rows.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = rows[0];

    // Check if the password is correct
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).send('Incorrect password');
    }

    // Create a session for the user
    req.session.userId = user.id;
    req.session.username = user.username; // Store the username in session
    res.redirect('/');  // Redirect to home page for regular users

  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Signup route
app.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;  // Expect username, email, and password

  if (!username || !email || !password) {
    return res.status(400).send('Missing required fields');
  }

  try {
    // Check if username or email already exists
    const [existingUsers] = await db.execute('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);

    if (existingUsers.length > 0) {
      return res.status(400).send('Username or Email already exists');
    }

    // Hash the password before storing
    const hashedPassword = await bcrypt.hash(password, 10);

    // Store the new user in the database
    await db.execute('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', [username, email, hashedPassword]);

    res.redirect('/login.html');  // Redirect to login page after signup

  } catch (error) {
    console.error('Error during signup:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Failed to log out');
    }
    res.clearCookie('connect.sid'); // Clear the session cookie
    res.redirect('/');  // Redirect to the homepage after logging out
  });
});

// API to check login status
app.get('/api/checkLogin', (req, res) => {
  if (req.session.userId) {
    // Check if the session contains user information
    res.json({ loggedIn: true, username: req.session.username || 'User' });
  } else {
    res.json({ loggedIn: false });
  }
});

// Fetch product details by ID
app.get('/api/products/:productId', async (req, res) => {
  const productId = req.params.productId;

  if (!productId) {
    return res.status(400).json({ error: 'Product ID is required' });
  }

  try {
    // Fetch the product details
    const [productRows] = await db.execute('SELECT * FROM products WHERE id = ?', [productId]);

    if (productRows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productRows[0];

    // Check if there are customizations available for this product
    const [customizationRows] = await db.execute('SELECT COUNT(*) AS customizations FROM product_colors WHERE product_id = ?', [productId]);
    const hasCustomizations = customizationRows[0].customizations > 0;

    // Include the hasCustomizations flag in the response
    res.json({ ...product, hasCustomizations });
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Database query error' });
  }
});

// Fetch product image by product ID
app.get('/getProductImage', (req, res) => {
  const productId = req.query.product_id;

  if (!productId) {
    return res.status(400).json({ error: "Product ID is missing" });
  }

  const query = 'SELECT image_url FROM products WHERE id = ?';
  db.query(query, [productId], (error, results) => {
    if (error) {
      console.error('Error fetching product image:', error);
      return res.status(500).json({ error: 'Error fetching product image' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ imageUrl: results[0].image_url });
  });
});

// Fetch product color options
app.get('/api/productColors', async (req, res) => {
  const productId = req.query.product_id;

  if (!productId) {
    return res.status(400).json({ error: 'Product ID is required' });
  }

  try {
    const [rows] = await db.execute('SELECT * FROM product_colors WHERE product_id = ?', [productId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No colors found for this product' });
    }

    res.json(rows);
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Database query error' });
  }
});

// Place an order
app.post('/api/placeOrder', async (req, res) => {
  const { productId, totalPrice, name, cardNumber, expirationDate, cvv } = req.body;

  // Ensure required fields are present
  if (!productId || !totalPrice || !name || !cardNumber || !expirationDate || !cvv) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let connection;
  try {
    // Use db.getConnection() to retrieve a connection from the pool
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Insert order
    const [orderResult] = await connection.query('INSERT INTO orders (user_id, total_price) VALUES (?, ?)', [req.session.userId, totalPrice]);
    const orderId = orderResult.insertId;

    // Insert order item
    await connection.query('INSERT INTO order_items (order_id, product_id, price) VALUES (?, ?, ?)', [orderId, productId, totalPrice]);

    // Commit transaction
    await connection.commit();
    connection.release();  // Ensure the connection is released back to the pool

    res.status(200).json({ message: 'Order placed successfully' });
  } catch (error) {
    console.error('Error placing order:', error);
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Error rolling back transaction:', rollbackError);
      } finally {
        connection.release();
      }
    }
    res.status(500).json({ error: 'Failed to place order' });
  }
});


// Fetch user orders with product details and customizations
app.get('/api/myOrders', async (req, res) => {
  const userId = req.session.userId;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [orders] = await db.query(`
      SELECT o.id AS order_id, o.total_price, o.created_at, 
             p.name AS product_name, oi.price AS item_price
      FROM orders o
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      WHERE o.user_id = ?
    `, [userId]);

    const ordersWithItems = orders.reduce((acc, order) => {
      const existingOrder = acc.find(o => o.id === order.order_id);
      if (existingOrder) {
        existingOrder.items.push({
          name: order.product_name,
          price: order.item_price
        });
      } else {
        acc.push({
          id: order.order_id,
          total_price: order.total_price,
          created_at: order.created_at,
          items: [{
            name: order.product_name,
            price: order.item_price
          }]
        });
      }
      return acc;
    }, []);

    res.status(200).json(ordersWithItems);
  } catch (error) {
    console.error('Error fetching orders from database:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Admin logout route
app.post('/adminLogout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Failed to log out');
    }
    res.clearCookie('connect.sid'); // Clear the session cookie
    res.redirect('/');  // Redirect to the homepage after logging out
  });
});

// API to fetch table names
app.get('/api/tables', async (req, res) => {
  try {
    const [tables] = await db.query('SHOW TABLES');
    const tableNames = tables.map(table => Object.values(table)[0]);
    res.json(tableNames);
  } catch (err) {
    console.error('Error fetching tables:', err);
    res.status(500).json({ error: 'Database query error' });
  }
});

// API to fetch table columns
app.get('/api/tableColumns', async (req, res) => {
  const table = req.query.table;

  if (!table) {
    return res.status(400).json({ error: 'Table name is required' });
  }

  // Validate table name
  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  try {
    const [columns] = await db.query(`SHOW COLUMNS FROM ${table}`);
    const columnNames = columns.map(col => col.Field); // Extract column names
    res.json(columnNames); // Send column names as JSON
  } catch (err) {
    console.error('Error fetching table columns:', err);
    res.status(500).json({ error: 'Database query error' });
  }
});

// API to fetch data from a specific table
app.get('/api/tableData', async (req, res) => {
  const table = req.query.table;

  if (!table) {
    return res.status(400).json({ error: 'Table name is required' });
  }

  // Validate table name
  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  try {
    const [rows] = await db.query(`SELECT * FROM ${table}`);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching table data:', err);
    res.status(500).json({ error: 'Database query error' });
  }
});

// API to add a row to a specific table
app.post('/api/addRow', async (req, res) => {
  const { table, data } = req.body;

  if (!table || !data) {
    return res.status(400).json({ error: 'Table name and data are required' });
  }

  // Validate table name
  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  const columns = Object.keys(data);
  const values = Object.values(data);

  try {
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    await db.query(sql, values);
    res.json({ message: 'Row added successfully' });
  } catch (err) {
    console.error('Error adding row:', err);
    res.status(500).json({ error: 'Database query error' });
  }
});

// API to delete a row from a specific table
// API to delete a row from a specific table
app.delete('/admin/delete/:table/:id', async (req, res) => {
  const { table, id } = req.params;

  // Validate table name
  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  try {
    // Use string interpolation to safely include the table name
    const query = `DELETE FROM \`${table}\` WHERE id = ?`;
    const [result] = await db.execute(query, [id]);

    if (result.affectedRows > 0) {
      res.status(200).send('Row deleted successfully');
    } else {
      res.status(404).send('Row not found');
    }
  } catch (error) {
    console.error('Error deleting row:', error.message);  // Print the detailed error
    res.status(500).send(`Error deleting row: ${error.message}`);  // Return the error to the client
  }
});

// Route to handle contact form submission
app.post('/submit-user_comments', async (req, res) => {
  const { name, email, comments } = req.body;

  if (!name || !email || !comments) {
      return res.status(400).send('All fields are required');
  }

  try {
      // Insert the contact form data into the database
      await db.execute('INSERT INTO user_comments (name, email, comments) VALUES (?, ?, ?)', [name, email, comments]);
      res.status(200).send('Thank you for your feedback!');
  } catch (error) {
      console.error('Error inserting contact form data:', error);
      res.status(500).send('Internal Server Error');
  }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
