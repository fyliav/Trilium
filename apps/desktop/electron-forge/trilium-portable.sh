#!/usr/bin/env sh

DIR=`dirname "$0"`
export TRILIUM_DATA_DIR="$DIR/trilium-data"

exec "$DIR/trilium"

