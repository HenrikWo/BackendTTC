# Debug version to find Piper binary location
FROM rhasspy/wyoming-piper:latest

EXPOSE 10200

# Find where piper is located
CMD ["sh", "-c", "find / -name 'piper' -type f 2>/dev/null | head -10 && sleep 30"]