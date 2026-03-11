const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../../db/index");
const { z } = require("zod");

const router = express.Router();

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

    // Create default welcome message
    const welcomeMessage = `🎉 مرحباً بك في Zaki Bot!

تم إنشاء حسابك بنجاح. الآن يمكنك:

📦 إضافة منتجاتك
📱 ربط رقم الواتساب
🤖 السماح لـ Zaki بالرد على العملاء

ابدأ الآن من لوحة التحكم!`;

    // Create shop
    const shop = await prisma.shop.create({
      data: {
        name,
        ownerName,
        phone,
        whatsappNumber,
        welcomeMessage,
        subscriptionStatus: "TRIAL",
        subscriptionEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days trial
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

    res.status(201).json({
      message: "Shop registered successfully",
      shop,
      token
    });

  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ error: "Failed to register shop" });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
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
        welcomeMessage: true,
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

    res.json({
      message: "Login successful",
      shop,
      token
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Failed to login" });
  }
});

module.exports = router;
