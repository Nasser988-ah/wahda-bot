const cloudinary = require('cloudinary').v2;
const fs = require('fs');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const BUCKET_NAME = 'cloudinary';

/**
 * Upload image to Cloudinary
 * @param {string} filePath - Local file path
 * @param {string} publicId - Unique identifier for the image
 * @returns {Promise<string>} - Public URL of the uploaded image
 */
async function uploadImage(filePath, publicId) {
  if (!isStorageConfigured()) {
    throw new Error('Cloudinary not configured');
  }

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      public_id: publicId,
      folder: 'wahda-products',
      resource_type: 'image',
      overwrite: true
    });

    console.log(`✅ Image uploaded to Cloudinary: ${result.secure_url}`);
    return result.secure_url;
  } catch (error) {
    console.error('❌ Cloudinary upload error:', error.message);
    throw error;
  }
}

/**
 * Delete image from Cloudinary
 * @param {string} imageUrl - URL of the image to delete
 */
async function deleteImage(imageUrl) {
  if (!isStorageConfigured() || !imageUrl) return;

  try {
    // Extract public_id from Cloudinary URL
    const publicId = extractPublicId(imageUrl);
    if (!publicId) return;

    const result = await cloudinary.uploader.destroy(publicId);
    console.log(`🗑️ Image deleted from Cloudinary: ${publicId}`, result);
  } catch (error) {
    console.error('Failed to delete image from Cloudinary:', error.message);
  }
}

/**
 * Extract public_id from Cloudinary URL
 */
function extractPublicId(url) {
  if (!url || !url.includes('cloudinary.com')) return null;
  
  try {
    // Parse Cloudinary URL format: https://res.cloudinary.com/{cloud}/image/upload/{version}/{folder}/{id}.{ext}
    const matches = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
    if (matches && matches[1]) {
      return matches[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if Cloudinary is configured
 */
function isStorageConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && 
            process.env.CLOUDINARY_API_KEY && 
            process.env.CLOUDINARY_API_SECRET);
}

module.exports = {
  uploadImage,
  deleteImage,
  isStorageConfigured,
  BUCKET_NAME
};
