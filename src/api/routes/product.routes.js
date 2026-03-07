const express = require("express");
const prisma = require("../../db/index");
const { authenticateToken } = require("../middleware/auth.middleware");
const { z } = require("zod");
const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// Validation schemas
const createProductSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  price: z.number().positive("Price must be positive"),
  description: z.string().optional(),
  category: z.string().optional(),
  isAvailable: z.boolean().default(true),
});

const updateProductSchema = z.object({
  name: z.string().min(1, "Product name is required").optional(),
  price: z.number().positive("Price must be positive").optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  isAvailable: z.boolean().optional(),
});

// Get all products for the shop
router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 20, category, available } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      shopId: req.shop.id,
      ...(category && { category }),
      ...(available !== undefined && { isAvailable: available === "true" })
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          price: true,
          description: true,
          category: true,
          isAvailable: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              orderItems: true
            }
          }
        }
      }),
      prisma.product.count({ where })
    ]);

    res.json({
      products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({ error: "Failed to get products" });
  }
});

// Get single product
router.get("/:id", async (req, res) => {
  try {
    const product = await prisma.product.findFirst({
      where: {
        id: req.params.id,
        shopId: req.shop.id
      },
      select: {
        id: true,
        name: true,
        price: true,
        description: true,
        category: true,
        isAvailable: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            orderItems: true
          }
        }
      }
    });

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(product);

  } catch (error) {
    console.error("Get product error:", error);
    res.status(500).json({ error: "Failed to get product" });
  }
});

// Create new product
router.post("/", async (req, res) => {
  try {
    const validation = createProductSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Validation failed", 
        details: validation.error.errors 
      });
    }

    const product = await prisma.product.create({
      data: {
        ...validation.data,
        shopId: req.shop.id
      },
      select: {
        id: true,
        name: true,
        price: true,
        description: true,
        category: true,
        isAvailable: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.status(201).json({
      message: "Product created successfully",
      product
    });

  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ error: "Failed to create product" });
  }
});

// Update product
router.put("/:id", async (req, res) => {
  try {
    const validation = updateProductSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Validation failed", 
        details: validation.error.errors 
      });
    }

    // Check if product exists and belongs to shop
    const existingProduct = await prisma.product.findFirst({
      where: {
        id: req.params.id,
        shopId: req.shop.id
      }
    });

    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: validation.data,
      select: {
        id: true,
        name: true,
        price: true,
        description: true,
        category: true,
        isAvailable: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({
      message: "Product updated successfully",
      product
    });

  } catch (error) {
    console.error("Update product error:", error);
    res.status(500).json({ error: "Failed to update product" });
  }
});

// Delete product
router.delete("/:id", async (req, res) => {
  try {
    // Check if product exists and belongs to shop
    const existingProduct = await prisma.product.findFirst({
      where: {
        id: req.params.id,
        shopId: req.shop.id
      },
      include: {
        _count: {
          select: {
            orderItems: true
          }
        }
      }
    });

    if (!existingProduct) {
      return res.status(404).json({ error: "Product not found" });
    }

    // Check if product has orders
    if (existingProduct._count.orderItems > 0) {
      return res.status(400).json({ 
        error: "Cannot delete product with existing orders. Consider marking it as unavailable instead." 
      });
    }

    await prisma.product.delete({
      where: { id: req.params.id }
    });

    res.json({
      message: "Product deleted successfully"
    });

  } catch (error) {
    console.error("Delete product error:", error);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// Get product categories
router.get("/categories/list", async (req, res) => {
  try {
    const categories = await prisma.product.findMany({
      where: {
        shopId: req.shop.id,
        category: { not: null }
      },
      select: {
        category: true
      },
      distinct: ["category"]
    });

    const categoryList = categories.map(c => c.category).filter(Boolean);

    res.json({
      categories: categoryList
    });

  } catch (error) {
    console.error("Get categories error:", error);
    res.status(500).json({ error: "Failed to get categories" });
  }
});

module.exports = router;
