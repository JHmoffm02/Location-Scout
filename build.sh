#!/bin/bash
# Vercel build script — injects environment variables into index.html
# Runs automatically on every Vercel deployment

sed -i "s|__SUPABASE_URL__|$SUPABASE_URL|g" index.html
sed -i "s|__SUPABASE_KEY__|$SUPABASE_KEY|g" index.html
sed -i "s|__GMAPS_KEY__|$GMAPS_KEY|g" index.html

echo "✓ Environment variables injected into index.html"
