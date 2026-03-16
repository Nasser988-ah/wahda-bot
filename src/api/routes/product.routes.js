const express = require("express");
const databaseService = require("../../services/databaseService");
const { authenticateToken } = require("../middleware/auth.middleware");
const { upload } = require("../../middleware/upload");
const { z } = require("zod");
const fs = require("fs");
const router = express.Router();
const botManager = require('../../bot/botManager');
const { uploadImage, isStorageConfigured } = require('../../services/storageService');

// Helper function to get Prisma client with error handling
function getPrisma() {
  if (!databaseService.isConnected) {
    throw new Error('Database is not configured');
  }
  const client = databaseService.getClient();
  if (!client) {
    throw new Error('Database connection failed');
  }
  return client;
}

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
    const prisma = getPrisma();

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
          imageUrl: true,
          stock: true,
          variants: true,
          variantImages: true,
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
    
    if (error.message.includes('Database')) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available" 
      });
    }
    
    res.status(500).json({ error: "Failed to get products" });
  }
});

// Get single product
router.get("/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
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
    
    if (error.message.includes('Database')) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available" 
      });
    }
    
    res.status(500).json({ error: "Failed to get product" });
  }
});

// Create new product
router.post("/", async (req, res) => {
  try {
    const prisma = getPrisma();
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

    // BUG 2 FIX: Invalidate cache so bot sees new product immediately
    botManager.invalidateShopCache(req.shop.id);

    res.status(201).json({
      message: "Product created successfully",
      product
    });

  } catch (error) {
    console.error("Create product error:", error);
    
    if (error.message.includes('Database')) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available" 
      });
    }
    
    res.status(500).json({ error: "Failed to create product" });
  }
});

// Update product
router.put("/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
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

    // BUG 2 FIX: Invalidate cache so bot sees updated product
    botManager.invalidateShopCache(req.shop.id);

    res.json({
      message: "Product updated successfully",
      product
    });

  } catch (error) {
    console.error("Update product error:", error);
    
    if (error.message.includes('Database')) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available" 
      });
    }
    
    res.status(500).json({ error: "Failed to update product" });
  }
});

// Delete product (mark as unavailable if has orders, otherwise delete)
router.delete("/:id", async (req, res) => {
  try {
    const prisma = getPrisma();
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
      // Mark as unavailable instead of deleting
      const updatedProduct = await prisma.product.update({
        where: { id: req.params.id },
        data: { isAvailable: false }
      });

      // BUG 2 FIX: Invalidate cache so bot sees product is unavailable
      botManager.invalidateShopCache(req.shop.id);

      return res.json({
        message: "تم إخفاء المنتج بنجاح (يحتوي على طلبات سابقة)",
        product: updatedProduct,
        action: "marked_unavailable"
      });
    }

    // No orders - safe to delete
    await prisma.product.delete({
      where: { id: req.params.id }
    });

    // BUG 2 FIX: Invalidate cache so bot sees product is deleted
    botManager.invalidateShopCache(req.shop.id);

    res.json({
      message: "تم حذف المنتج بنجاح"
    });

  } catch (error) {
    console.error("Delete product error:", error);
    
    if (error.message.includes('Database')) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available" 
      });
    }
    
    res.status(500).json({ error: "فشل حذف المنتج" });
  }
});

// Get product categories
router.get("/categories/list", async (req, res) => {
  try {
    const prisma = getPrisma();
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
    
    if (error.message.includes('Database')) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available" 
      });
    }
    
    res.status(500).json({ error: "Failed to get categories" });
  }
});

// Upload product image
router.post("/:id/image", upload.single('image'), async (req, res) => {
  try {
    const prisma = getPrisma();
    
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    // Check if product exists and belongs to shop
    const existingProduct = await prisma.product.findFirst({
      where: {
        id: req.params.id,
        shopId: req.shop.id
      }
    });

    if (!existingProduct) {
      // Delete uploaded temp file if product not found
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Product not found" });
    }

    let imageUrl;
    let storageType = 'local';
    
    // Try Supabase Storage first if configured
    if (isStorageConfigured()) {
      try {
        // Generate unique filename with shopId as folder
        const timestamp = Date.now();
        const filename = `${req.shop.id}/${req.params.id}_${timestamp}.jpg`;
        
        // Upload to Supabase Storage
        imageUrl = await uploadImage(req.file.path, filename);
        storageType = 'supabase';
        console.log(`✅ Image uploaded to Supabase: ${imageUrl}`);
      } catch (supabaseError) {
        console.warn('⚠️ Supabase upload failed, falling back to local storage:', supabaseError.message);
        // Fall through to local storage
      }
    }
    
    // Fall back to local storage if Supabase failed or not configured
    if (!imageUrl) {
      const localFilename = `${Date.now()}_${req.file.originalname || 'image.jpg'}`;
      const localDir = 'public/uploads';
      const localPath = `${localDir}/${localFilename}`;
      
      // Ensure uploads directory exists
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      
      // Move file to uploads directory
      fs.copyFileSync(req.file.path, localPath);
      imageUrl = `/uploads/${localFilename}`;
      
      console.log(`💾 Image saved locally: ${imageUrl} (⚠️ will be lost on server restart)`);
    }

    // Clean up temp file if still exists
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Delete old image from Supabase if it was stored there
    if (existingProduct.imageUrl && existingProduct.imageUrl.includes('supabase.co') && storageType === 'supabase') {
      try {
        const { deleteImage } = require('../../services/storageService');
        await deleteImage(existingProduct.imageUrl);
      } catch (e) {
        // Ignore errors when deleting old image
      }
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrl },
      select: {
        id: true,
        name: true,
        imageUrl: true
      }
    });

    // Invalidate cache so bot sees new image
    botManager.invalidateShopCache(req.shop.id);

    res.json({
      message: "تم رفع الصورة بنجاح",
      imageUrl,
      storageType,
      product
    });

  } catch (error) {
    console.error("Upload image error:", error);
    
    // Delete temp uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    
    res.status(500).json({ error: "Failed to upload image", details: error.message });
  }
});

module.exports = router;
