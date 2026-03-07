const prisma = require("./index");

async function getAllShops() {
  return prisma.shop.findMany({ orderBy: { createdAt: "desc" } });
}

async function getShopById(id) {
  return prisma.shop.findUnique({ where: { id } });
}

async function createShop(data) {
  return prisma.shop.create({
    data: {
      name: data.name,
      phone: data.phone,
      plan: data.plan || "FREE",
    },
  });
}

module.exports = { getAllShops, getShopById, createShop };
