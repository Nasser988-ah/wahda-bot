const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../../db/index");
const databaseService = require("../../services/databaseService");
const { z } = require("zod");

const router = express.Router();

// Helper function to get Prisma client
function getPrisma() {
  if (!databaseService.isConnected) {
    throw new Error('Database is not configured. Please set DATABASE_URL environment variable.');
  }
  return databaseService.getClient();
}

// Validation schemas
const registerSchema = z.object({
  name: z.string().min(2, "Shop name must be at least 2 characters"),
  ownerName: z.string().min(2, "Owner name must be at least 2 characters"),
  phone: z.string().regex(/^20\d{10}$/, "Phone must be Egyptian number starting with 20"),
  whatsappNumber: z.string().regex(/^20\d{10}$/, "WhatsApp number must be Egyptian number starting with 20"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const loginSchema = z.object({
  phone: z.string().regex(/^20\d{10}$/, "Phone must be Egyptian number starting with 20"),
  password: z.string().min(1, "Password is required"),
});

// Register new shop
router.post("/register", async (req, res) => {
  try {
    // Check database availability
    const prisma = getPrisma();

    const validation = registerSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Validation failed", 
        details: validation.error.errors 
      });
    }

    const { name, ownerName, phone, whatsappNumber, password } = validation.data;

    // Check if shop already exists
    const existingShop = await prisma.shop.findUnique({
      where: { phone }
    });

    if (existingShop) {
      return res.status(400).json({ error: "Shop with this phone number already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create shop with pending payment status
    const shop = await prisma.shop.create({
      data: {
        name,
        ownerName,
        phone,
        whatsappNumber,
        subscriptionStatus: "PENDING_PAYMENT",
        subscriptionEnd: null,
      },
      select: {
        id: true,
        name: true,
        ownerName: true,
        phone: true,
        whatsappNumber: true,
        subscriptionStatus: true,
        subscriptionEnd: true,
        createdAt: true
      }
    });

    // Create admin user
    await prisma.admin.create({
      data: {
        email: `${phone}@wahdabot.com`, // Temporary email
        password: hashedPassword,
      }
    });

    // Generate JWT token
    const token = jwt.sign(
      { shopId: shop.id, phone: shop.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.status(201).json({
      message: "Shop registered successfully",
      shop,
      token
    });

  } catch (error) {
    console.error("Registration error:", error);
    console.error("Error stack:", error.stack);
    
    // Check if error is due to missing database
    if (error.message.includes('Database is not configured') || error.message.includes('DATABASE_URL')) {
      return res.status(503).json({ 
        error: "Service unavailable", 
        message: "Database is not configured. Please contact support." 
      });
    }
    
    res.status(500).json({ error: "Failed to register shop" });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    // Check database availability
    const prisma = getPrisma();

    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Validation failed", 
        details: validation.error.errors 
      });
    }

    const { phone, password } = validation.data;

    // Find shop
    const shop = await prisma.shop.findUnique({
      where: { phone },
      select: {
        id: true,
        name: true,
        ownerName: true,
        phone: true,
        whatsappNumber: true,
        subscriptionStatus: true,
        subscriptionEnd: true,
        createdAt: true
      }
    });

    if (!shop) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Find admin user
    const admin = await prisma.admin.findFirst({
      where: {
        email: `${phone}@wahdabot.com`
      },
      select: {
        id: true,
        email: true,
        password: true
      }
    });
    if (!admin) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, admin.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check subscription
    if (shop.subscriptionStatus === "PENDING_PAYMENT") {
      const token = jwt.sign(
        { shopId: shop.id, phone: shop.phone },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
      );

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });

      return res.status(402).json({ 
        error: "Payment required",
        paymentRequired: true,
        message: "Your account is pending payment approval",
        shop,
        token
      });
    }

    if (shop.subscriptionStatus === "EXPIRED") {
      return res.status(403).json({ error: "Subscription expired" });
    }

    if (shop.subscriptionStatus === "TRIAL" && shop.subscriptionEnd && shop.subscriptionEnd < new Date()) {
      return res.status(403).json({ error: "Trial period expired" });
    }

    // Generate JWT token
    const token = jwt.sign(
      { shopId: shop.id, phone: shop.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({
      message: "Login successful",
      shop,
      token
    });

  } catch (error) {
    console.error("Login error:", error);
    
    // Check if error is due to missing database
    if (error.message.includes('Database is not configured') || error.message.includes('DATABASE_URL')) {
      return res.status(503).json({ 
        error: "Service unavailable", 
        message: "Database is not configured. Please contact support." 
      });
    }
    
    res.status(500).json({ error: "Failed to login" });
  }
});

// Logout - clear cookie
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

module.exports = router;
