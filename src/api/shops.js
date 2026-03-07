const express = require("express");
const router = express.Router();
const { getAllShops, createShop, getShopById } = require("../db/shops");
const { authenticate } = require("../middleware/auth");

// Public
router.post("/", async (req, res) => {
  try {
    const shop = await createShop(req.body);
    res.status(201).json(shop);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Protected
router.get("/", authenticate, async (req, res) => {
  try {
    const shops = await getAllShops();
    res.json(shops);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:id", authenticate, async (req, res) => {
  try {
    const shop = await getShopById(req.params.id);
    if (!shop) return res.status(404).json({ error: "Shop not found" });
    res.json(shop);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
