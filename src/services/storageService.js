const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('⚠️ Supabase credentials not configured. Images will be stored locally.');
}

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const BUCKET_NAME = 'product-images';

/**
 * Upload image to Supabase Storage
 * @param {string} filePath - Local file path
 * @param {string} filename - Desired filename in storage
 * @returns {Promise<string>} - Public URL of the uploaded image
 */
async function uploadImage(filePath, filename) {
  if (!supabase) {
    throw new Error('Supabase not configured');
  }

  try {
    // Read file
    const fileBuffer = fs.readFileSync(filePath);
    
    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filename, fileBuffer, {
        contentType: getContentType(filename),
        upsert: true // Overwrite if exists
      });

    if (error) {
      console.error('Supabase upload error:', error);
      throw error;
    }

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filename);

    console.log(`✅ Image uploaded to Supabase: ${publicUrlData.publicUrl}`);
    return publicUrlData.publicUrl;
  } catch (error) {
    console.error('Failed to upload image to Supabase:', error);
    throw error;
  }
}

/**
 * Delete image from Supabase Storage
 * @param {string} imageUrl - Public URL of the image to delete
 */
async function deleteImage(imageUrl) {
  if (!supabase || !imageUrl) return;

  try {
    // Extract filename from URL
    const filename = extractFilenameFromUrl(imageUrl);
    if (!filename) return;

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([filename]);

    if (error) {
      console.error('Supabase delete error:', error);
    } else {
      console.log(`🗑️ Image deleted from Supabase: ${filename}`);
    }
  } catch (error) {
    console.error('Failed to delete image from Supabase:', error);
  }
}

/**
 * Extract filename from Supabase public URL
 */
function extractFilenameFromUrl(url) {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    return pathParts[pathParts.length - 1];
  } catch {
    // If URL parsing fails, try simple string extraction
    const parts = url.split('/');
    return parts[parts.length - 1];
  }
}

/**
 * Get content type based on file extension
 */
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  return contentTypes[ext] || 'image/jpeg';
}

/**
 * Check if Supabase storage is configured
 */
function isStorageConfigured() {
  return !!supabase;
}

module.exports = {
  uploadImage,
  deleteImage,
  isStorageConfigured,
  BUCKET_NAME
};
