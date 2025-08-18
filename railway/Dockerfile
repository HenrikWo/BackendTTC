# Use Wyoming Piper base image
FROM rhasspy/wyoming-piper:latest

# Expose the port
EXPOSE 10200

# Start Wyoming Piper with Norwegian voice using Railway volume
# The volume /app/models will be mounted by Railway automatically
CMD ["python3", "-m", "wyoming_piper", "--voice", "no_NO-talesyntese-medium", "--port", "10200", "--data-dir", "/app/models"]