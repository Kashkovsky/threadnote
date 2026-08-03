# Fixture architecture

The application calls the search package. Search serializes recall and vector-index activation through the core
exclusive file-lock contract. Lock recovery must preserve the previous ready index.
