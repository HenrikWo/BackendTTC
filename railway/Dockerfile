# Use Wyoming Piper base image
FROM rhasspy/wyoming-piper:latest

# Expose the port
EXPOSE 10200

# Start Wyoming Piper with correct arguments
# Need to specify both --piper path and --voice
CMD ["python3", "-m", "wyoming_piper", \
     "--piper", "/usr/local/bin/piper", \
     "--voice", "no_NO-talesyntese-medium", \
     "--uri", "tcp://0.0.0.0:10200", \
     "--data-dir", "/app/models"]