const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Mulige volume paths å sjekke
const POSSIBLE_PATHS = [
    '/app/models',
    '/data',
    '/data/models', 
    '/volume',
    '/volume/models',
    '/mnt/volume',
    '/mnt/volume/models',
    '/storage',
    '/storage/models',
    '/app/data',
    '/app/storage',
    '/models',
    process.cwd() + '/models',
    process.cwd() + '/data'
];

// Finn riktig models directory
let MODELS_DIR = '/app/models'; // default

function findModelsDirectory() {
    console.log('🔍 Searching for writable volume directory...');
    
    for (const testPath of POSSIBLE_PATHS) {
        try {
            // Test om directory eksisterer
            const exists = fs.existsSync(testPath);
            console.log(`📁 Testing ${testPath}: exists=${exists}`);
            
            if (!exists) {
                try {
                    fs.mkdirSync(testPath, { recursive: true });
                    console.log(`✅ Created directory: ${testPath}`);
                } catch (createErr) {
                    console.log(`❌ Cannot create ${testPath}: ${createErr.message}`);
                    continue;
                }
            }
            
            // Test skrivetilgang
            const testFile = path.join(testPath, 'test_write.txt');
            try {
                fs.writeFileSync(testFile, 'test');
                fs.unlinkSync(testFile);
                console.log(`✅ Write test successful: ${testPath}`);
                return testPath;
            } catch (writeErr) {
                console.log(`❌ Cannot write to ${testPath}: ${writeErr.message}`);
            }
            
        } catch (err) {
            console.log(`❌ Error testing ${testPath}: ${err.message}`);
        }
    }
    
    console.log('⚠️ No writable directory found, using default');
    return '/app/models';
}

// Finn riktig directory ved oppstart
MODELS_DIR = findModelsDirectory();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// System info endpoint
app.get('/api/system-info', (req, res) => {
    const systemInfo = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        cwd: process.cwd(),
        env: {
            RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH,
            RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
            NODE_ENV: process.env.NODE_ENV
        },
        detectedModelsDir: MODELS_DIR
    };
    
    // Test alle mulige paths
    const pathTests = POSSIBLE_PATHS.map(testPath => {
        try {
            const exists = fs.existsSync(testPath);
            let canWrite = false;
            let files = [];
            
            if (exists) {
                try {
                    const testFile = path.join(testPath, 'write_test.tmp');
                    fs.writeFileSync(testFile, 'test');
                    fs.unlinkSync(testFile);
                    canWrite = true;
                } catch (e) {
                    canWrite = false;
                }
                
                try {
                    files = fs.readdirSync(testPath);
                } catch (e) {
                    files = ['ERROR: ' + e.message];
                }
            }
            
            return {
                path: testPath,
                exists,
                canWrite,
                files: files.slice(0, 10) // bare de første 10 filene
            };
        } catch (error) {
            return {
                path: testPath,
                error: error.message
            };
        }
    });
    
    res.json({
        ...systemInfo,
        pathTests
    });
});

// Health check med mer detaljert info
app.get('/health', (req, res) => {
    let modelInfo = { exists: false, files: [], canWrite: false };
    
    try {
        if (fs.existsSync(MODELS_DIR)) {
            modelInfo.exists = true;
            modelInfo.files = fs.readdirSync(MODELS_DIR);
            
            // Test skrivetilgang
            try {
                const testFile = path.join(MODELS_DIR, 'health_check.tmp');
                fs.writeFileSync(testFile, new Date().toISOString());
                fs.unlinkSync(testFile);
                modelInfo.canWrite = true;
            } catch (writeErr) {
                modelInfo.writeError = writeErr.message;
            }
        }
    } catch (err) {
        modelInfo.error = err.message;
    }
    
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        models_directory: MODELS_DIR,
        models_info: modelInfo,
        environment: {
            NODE_ENV: process.env.NODE_ENV,
            RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
            RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH
        }
    });
});

// List available models
app.get('/api/models', (req, res) => {
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            return res.json({ 
                message: 'Models directory ikke funnet',
                models: [],
                directory: MODELS_DIR,
                suggestion: 'Bruk /api/system-info for å finne riktig path'
            });
        }
        
        const files = fs.readdirSync(MODELS_DIR);
        const modelFiles = files.filter(file => 
            file.endsWith('.onnx') || 
            file.endsWith('.json') || 
            file.endsWith('.bin')
        );
        
        const modelInfo = modelFiles.map(filename => {
            const filePath = path.join(MODELS_DIR, filename);
            const stats = fs.statSync(filePath);
            
            return {
                filename,
                size: Math.round(stats.size / (1024 * 1024) * 100) / 100 + ' MB',
                modified: stats.mtime.toISOString()
            };
        });
        
        res.json({
            models: modelInfo,
            all_files: files, // vis ALLE filer
            total_files: files.length,
            model_files: modelFiles.length,
            directory: MODELS_DIR
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Could not read models directory',
            details: error.message,
            directory: MODELS_DIR
        });
    }
});

// Test write endpoint
app.post('/api/test-write', (req, res) => {
    const { text = 'Test write from Railway API' } = req.body;
    
    try {
        const testFilePath = path.join(MODELS_DIR, 'api_test.txt');
        fs.writeFileSync(testFilePath, `${text}\nTimestamp: ${new Date().toISOString()}`);
        
        const content = fs.readFileSync(testFilePath, 'utf8');
        
        res.json({
            success: true,
            message: 'File written and read successfully',
            filePath: testFilePath,
            content: content,
            directory: MODELS_DIR
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            directory: MODELS_DIR
        });
    }
});

// Forenklet download endpoint for testing
app.post('/api/download-models', async (req, res) => {
    try {
        console.log('📁 Models directory:', MODELS_DIR);
        console.log('📁 Directory exists:', fs.existsSync(MODELS_DIR));
        
        if (!fs.existsSync(MODELS_DIR)) {
            console.log('Creating models directory...');
            fs.mkdirSync(MODELS_DIR, { recursive: true });
        }
        
        // Test en liten fil først
        const testUrl = 'https://httpbin.org/json'; // Liten test JSON
        console.log('Testing download from httpbin.org...');
        
        const response = await fetch(testUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const buffer = await response.arrayBuffer();
        const testFilePath = path.join(MODELS_DIR, 'test_download.json');
        fs.writeFileSync(testFilePath, Buffer.from(buffer));
        
        console.log('✅ Test download successful');
        
        res.json({
            message: 'Test download successful!',
            testFile: testFilePath,
            fileSize: buffer.byteLength,
            directory: MODELS_DIR,
            files: fs.readdirSync(MODELS_DIR)
        });
        
    } catch (error) {
        console.error('❌ Test download failed:', error);
        res.status(500).json({
            error: 'Test download failed',
            details: error.message,
            directory: MODELS_DIR
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Railway TTS Backend (DEBUG) running on port ${PORT}`);
    console.log(`📁 Models directory: ${MODELS_DIR}`);
    console.log(`🔗 System info: http://localhost:${PORT}/api/system-info`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🔗 Test write: POST /api/test-write`);
    
    // Environment info
    console.log('🌍 Environment variables:');
    console.log('  RAILWAY_VOLUME_MOUNT_PATH:', process.env.RAILWAY_VOLUME_MOUNT_PATH);
    console.log('  RAILWAY_ENVIRONMENT:', process.env.RAILWAY_ENVIRONMENT);
    console.log('  NODE_ENV:', process.env.NODE_ENV);
});