const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Øk grense for bilder
app.use(express.urlencoded({ extended: true }));

// Sørg for at uploads mappen eksisterer
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

// In-memory storage som backup (Railway har ikke persistent storage)
const imageStore = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    stored_images: imageStore.size
  });
});

// Upload endpoint
app.post('/upload', async (req, res) => {
  try {
    const { image, filename } = req.body;
    
    if (!image || !filename) {
      return res.status(400).json({ 
        success: false, 
        error: 'Mangler image eller filename' 
      });
    }

    // Valider at det er base64 bilde data
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Ugyldig bilde format' 
      });
    }

    // Lagre i memory (siden Railway ikke har persistent disk)
    const timestamp = Date.now();
    const uniqueFilename = `${timestamp}_${filename}`;
    
    imageStore.set(uniqueFilename, {
      data: image,
      originalName: filename,
      uploadTime: new Date().toISOString()
    });

    // Også prøv å lagre på disk (vil forsvinne ved restart på Railway)
    try {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      await fs.writeFile(path.join(uploadsDir, uniqueFilename), buffer);
      console.log(`Bilde lagret på disk: ${uniqueFilename}`);
    } catch (diskError) {
      console.warn('Kunne ikke lagre på disk:', diskError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Bilde lastet opp successfully!',
      filename: uniqueFilename,
      originalName: filename
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: 'Server feil ved opplasting'
    });
  }
});

// Hent bilde endpoint
app.get('/image/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    // Sjekk først in-memory storage
    if (imageStore.has(filename)) {
      const imageData = imageStore.get(filename);
      return res.status(200).json({
        success: true,
        image: imageData.data,
        filename: filename,
        originalName: imageData.originalName,
        uploadTime: imageData.uploadTime
      });
    }

    // Prøv å lese fra disk
    try {
      const buffer = await fs.readFile(path.join(uploadsDir, filename));
      const base64 = buffer.toString('base64');
      const mimeType = 'image/jpeg'; // Default, kunne vært smartere
      const dataUrl = `data:${mimeType};base64,${base64}`;
      
      return res.status(200).json({
        success: true,
        image: dataUrl,
        filename: filename
      });
    } catch (diskError) {
      console.warn('Kunne ikke lese fra disk:', diskError.message);
    }

    // Bilde ikke funnet
    res.status(404).json({
      success: false,
      error: 'Bilde ikke funnet'
    });

  } catch (error) {
    console.error('Get image error:', error);
    res.status(500).json({
      success: false,
      error: 'Server feil ved henting av bilde'
    });
  }
});

// List alle bilder
app.get('/images', (req, res) => {
  const images = Array.from(imageStore.entries()).map(([filename, data]) => ({
    filename,
    originalName: data.originalName,
    uploadTime: data.uploadTime
  }));

  res.status(200).json({
    success: true,
    images,
    count: images.length
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Railway backend kjører på port ${PORT}`);
  console.log(`Uploads directory: ${uploadsDir}`);
});