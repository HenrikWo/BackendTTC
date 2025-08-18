// TTS Frontend API - Railway Backend Integration
const BACKEND_URL = 'https://backendttc-production.up.railway.app';

// TTS Request Function
async function sendTTSRequest(text, voice = 'default') {
    try {
        console.log('📤 Sending TTS request:', text);
        
        const response = await fetch(`${BACKEND_URL}/api/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                text: text,
                voice: voice 
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('✅ TTS Job created:', result);
        
        // Start polling for completion
        if (result.jobId) {
            return await pollJobCompletion(result.jobId);
        }
        
        return result;
        
    } catch (error) {
        console.error('❌ TTS Request failed:', error);
        throw error;
    }
}

// Poll Job Status
async function pollJobCompletion(jobId, maxAttempts = 30, interval = 2000) {
    console.log('🔄 Polling job status:', jobId);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(`${BACKEND_URL}/api/job/${jobId}`);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const status = await response.json();
            console.log(`📊 Job status (${attempt}/${maxAttempts}):`, status.status, `${status.progress || 0}%`);
            
            // Update UI with progress
            updateProgress(status);
            
            if (status.status === 'completed') {
                console.log('✅ Job completed!', status);
                return status;
            }
            
            if (status.status === 'failed') {
                console.error('❌ Job failed:', status.error);
                throw new Error(`TTS processing failed: ${status.error}`);
            }
            
            // Wait before next poll
            if (attempt < maxAttempts) {
                await sleep(interval);
            }
            
        } catch (error) {
            console.error(`❌ Polling attempt ${attempt} failed:`, error);
            if (attempt === maxAttempts) {
                throw error;
            }
            await sleep(interval);
        }
    }
    
    throw new Error('Job polling timeout - job did not complete in time');
}

// Update Progress in UI
function updateProgress(status) {
    const progressElement = document.getElementById('tts-progress');
    const statusElement = document.getElementById('tts-status');
    
    if (progressElement) {
        const progress = status.progress || 0;
        progressElement.style.width = `${progress}%`;
        progressElement.textContent = `${progress}%`;
    }
    
    if (statusElement) {
        const statusText = {
            'queued': '🔄 I kø...',
            'processing': '⚙️ Prosesserer...',
            'loading_model': '📥 Laster modell...',
            'generating_audio': '🎵 Genererer lyd...',
            'finalizing': '✨ Ferdigstiller...',
            'completed': '✅ Ferdig!',
            'failed': '❌ Feilet'
        };
        
        statusElement.textContent = statusText[status.status] || status.status;
    }
}

// Check Backend Health
async function checkBackendHealth() {
    try {
        const response = await fetch(`${BACKEND_URL}/health`);
        const health = await response.json();
        
        console.log('🏥 Backend health:', health);
        
        return {
            online: response.ok,
            modelsAvailable: health.models_info?.exists && 
                           health.models_info?.files?.some(f => f.endsWith('.onnx')),
            details: health
        };
        
    } catch (error) {
        console.error('❌ Backend health check failed:', error);
        return {
            online: false,
            modelsAvailable: false,
            error: error.message
        };
    }
}

// List Available Models
async function listModels() {
    try {
        const response = await fetch(`${BACKEND_URL}/api/models`);
        const models = await response.json();
        
        console.log('🤖 Available models:', models);
        return models;
        
    } catch (error) {
        console.error('❌ Failed to list models:', error);
        throw error;
    }
}

// Utility Functions
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// DOM Event Handlers (example usage)
document.addEventListener('DOMContentLoaded', async () => {
    // Check backend on page load
    const health = await checkBackendHealth();
    
    if (!health.online) {
        showError('Backend er ikke tilgjengelig');
        return;
    }
    
    if (!health.modelsAvailable) {
        showError('TTS modeller er ikke tilgjengelige');
        return;
    }
    
    console.log('✅ TTS System ready!');
    
    // Setup TTS form if it exists
    const ttsForm = document.getElementById('tts-form');
    const textInput = document.getElementById('tts-text');
    const submitButton = document.getElementById('tts-submit');
    
    if (ttsForm && textInput && submitButton) {
        ttsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const text = textInput.value.trim();
            if (!text) {
                showError('Vennligst skriv inn tekst');
                return;
            }
            
            try {
                submitButton.disabled = true;
                submitButton.textContent = 'Prosesserer...';
                
                showProgress(true);
                
                const result = await sendTTSRequest(text);
                
                if (result.audioUrl) {
                    // If we get an audio URL, play it
                    playAudio(result.audioUrl);
                    showSuccess('TTS generert successfully!');
                } else {
                    showSuccess('TTS prosessering ferdig!');
                }
                
            } catch (error) {
                showError(`TTS feilet: ${error.message}`);
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Generer tale';
                showProgress(false);
            }
        });
    }
});

// UI Helper Functions
function showError(message) {
    console.error('UI Error:', message);
    // Implement your error display logic
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }
}

function showSuccess(message) {
    console.log('UI Success:', message);
    // Implement your success display logic
    const successDiv = document.getElementById('success-message');
    if (successDiv) {
        successDiv.textContent = message;
        successDiv.style.display = 'block';
    }
}

function showProgress(show) {
    const progressDiv = document.getElementById('progress-container');
    if (progressDiv) {
        progressDiv.style.display = show ? 'block' : 'none';
    }
}

function playAudio(audioUrl) {
    const audio = new Audio(audioUrl);
    audio.play().catch(error => {
        console.error('Audio playback failed:', error);
        showError('Kunne ikke spille av lyd');
    });
}

// Export functions for use in other scripts
window.TTS = {
    sendRequest: sendTTSRequest,
    checkHealth: checkBackendHealth,
    listModels: listModels
};