export function maskImageCanvas(imageCanvas, maskCanvas) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  canvas.height = imageCanvas.height;
  canvas.width = imageCanvas.width;

  context.drawImage(
    maskCanvas,
    0,
    0,
    maskCanvas.width,
    maskCanvas.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  context.globalCompositeOperation = "source-in";
  context.drawImage(
    imageCanvas,
    0,
    0,
    imageCanvas.width,
    imageCanvas.height,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return canvas;
}

export function resizeCanvas(canvasOrig, size) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.height = size.h;
  canvas.width = size.w;

  ctx.drawImage(
    canvasOrig,
    0,
    0,
    canvasOrig.width,
    canvasOrig.height,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return canvas;
}

// input: 2x Canvas, output: One new Canvas, resize source
export function mergeMasks(sourceMask, targetMask) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.height = targetMask.height;
  canvas.width = targetMask.width;

  ctx.drawImage(targetMask, 0, 0);
  ctx.drawImage(
    sourceMask,
    0,
    0,
    sourceMask.width,
    sourceMask.height,
    0,
    0,
    targetMask.width,
    targetMask.height
  );

  return canvas;
}

// input: source and target {w, h}, output: {x,y,w,h} to fit source nicely into target preserving aspect
export function resizeAndPadBox(sourceDim, targetDim) {
  if (sourceDim.h == sourceDim.w) {
    return { x: 0, y: 0, w: targetDim.w, h: targetDim.h };
  } else if (sourceDim.h > sourceDim.w) {
    // portrait => resize and pad left
    const newW = (sourceDim.w / sourceDim.h) * targetDim.w;
    const padLeft = Math.floor((targetDim.w - newW) / 2);

    return { x: padLeft, y: 0, w: newW, h: targetDim.h };
  } else if (sourceDim.h < sourceDim.w) {
    // landscape => resize and pad top
    const newH = (sourceDim.h / sourceDim.w) * targetDim.h;
    const padTop = Math.floor((targetDim.h - newH) / 2);

    return { x: 0, y: padTop, w: targetDim.w, h: newH };
  }
}

/** 
 * input: onnx Tensor [B, *, W, H] and index idx
 * output: Tensor [B, idx, W, H]
 **/
export function sliceTensor(tensor, idx) {
  const [bs, noMasks, width, height] = tensor.dims;
  const stride = width * height;
  const start = stride * idx,
    end = start + stride;

  return tensor.cpuData.slice(start, end);
}

/**
 * input: Float32Array representing ORT.Tensor of shape [1, 1, width, height]
 * output: HTMLCanvasElement (4 channels, RGBA)
 **/
export function float32ArrayToCanvas(array, width, height) {
  const C = 4; // 4 output channels, RGBA
  const imageData = new Uint8ClampedArray(array.length * C);

  for (let srcIdx = 0; srcIdx < array.length; srcIdx++) {
    const trgIdx = srcIdx * C;
    const maskedPx = array[srcIdx] > 0;
    imageData[trgIdx] = maskedPx > 0 ? 0x32 : 0;
    imageData[trgIdx + 1] = maskedPx > 0 ? 0xcd : 0;
    imageData[trgIdx + 2] = maskedPx > 0 > 0 ? 0x32 : 0;
    // imageData[trgIdx + 3] = maskedPx > 0 ? 150 : 0 // alpha
    imageData[trgIdx + 3] = maskedPx > 0 ? 255 : 0; // alpha
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.height = height;
  canvas.width = width;
  ctx.putImageData(new ImageData(imageData, width, height), 0, 0);

  return canvas;
}

/** 
 * input: HTMLCanvasElement (RGB)
 * output: Float32Array for later conversion to ORT.Tensor of shape [1, 3, canvas.width, canvas.height]
 *  
 * inspired by: https://onnxruntime.ai/docs/tutorials/web/classify-images-nextjs-github-template.html
 **/
export function canvasToFloat32Array(canvas) {
  const imageData = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const shape = [1, 3, canvas.width, canvas.height];

  const [redArray, greenArray, blueArray] = [[], [], []];

  for (let i = 0; i < imageData.length; i += 4) {
    redArray.push(imageData[i]);
    greenArray.push(imageData[i + 1]);
    blueArray.push(imageData[i + 2]);
    // skip data[i + 3] to filter out the alpha channel
  }

  const transposedData = redArray.concat(greenArray).concat(blueArray);

  let i,
    l = transposedData.length;
  const float32Array = new Float32Array(shape[1] * shape[2] * shape[3]);
  for (i = 0; i < l; i++) {
    float32Array[i] = transposedData[i] / 255.0; // convert to float
  }

  return { float32Array, shape };
}

/** 
 * input: HTMLCanvasElement (RGB)
 * output: Float32Array for later conversion to ORT.Tensor of shape [1, 3, canvas.width, canvas.height]
 *  
 * inspired by: https://onnxruntime.ai/docs/tutorials/web/classify-images-nextjs-github-template.html
 **/
export function maskCanvasToFloat32Array(canvas) {
  const imageData = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;

  const shape = [1, 1, canvas.width, canvas.height];
  const float32Array = new Float32Array(shape[1] * shape[2] * shape[3]);

  for (let i = 0; i < float32Array.length; i++) {
    float32Array[i] = (imageData[i] + imageData[i + 1] + imageData[i + 2]) / (3 * 255.0); // convert avg to float
  }

  return float32Array;
}

/**
 * Traces the contour of a binary mask using the Moore-Neighbor tracing algorithm.
 * @param {Uint8ClampedArray|Uint8Array} data - The raw pixel data (or single channel). 
 *                                              If using ImageData.data (RGBA), stride should be 4. 
 *                                              If single channel, stride should be 1.
 * @param {number} width - Width of the mask
 * @param {number} height - Height of the mask
 * @returns {Array<{x: number, y: number}>} - Array of points representing the polygon
 */
export function traceContours(data, width, height) {
  const points = [];
  const stride = data.length === width * height ? 1 : 4;

  // Helper to check if a pixel is set (non-zero)
  const isSet = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const idx = (y * width + x) * stride;
    // For RGBA, check red channel. Mask is usually (R=50, G=205, B=50) or similar.
    // Ensure we trigger on any non-zero value.
    if (stride === 1) return data[idx] > 0;
    return data[idx] > 0 || data[idx + 1] > 0 || data[idx + 2] > 0;
  };

  // 1. Find a starting pixel (first non-zero pixel)
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isSet(x, y)) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }

  // If no mask found, return empty
  if (startX === -1) return [];

  // 2. Moore-Neighbor Tracing
  // Directions: N, NE, E, SE, S, SW, W, NW (0 to 7)
  // offsets for x, y
  const dx = [0, 1, 1, 1, 0, -1, -1, -1];
  const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

  let x = startX;
  let y = startY;

  points.push({ x, y });

  let pX = x;
  let pY = y;

  // Initial Backtrack: Simulate arriving from West (dx=-1, dy=0)
  // So we "entered" from direction 6. 
  // We want to start searching neighbors of P from 0 (North).
  // Actually, standard Moore: B = (x, y-1) ?? No.
  // Let's use the explicit "search start index" state.
  // If we found startX, startY by scanning top-left, we know (startX, startY-1) is 0? 
  // No, startY-1 might be invalid (if y=0) or we scanned it.
  // We know (startX-1, startY) is 0 (West).

  // Let's set initial search direction for the *next* move.
  // We act as if we came from West (Direction 6).
  // Next search starts at (Arrival + 5) % 8 ? => (6+5)%8 = 11%8 = 3? (SE).
  // Wait, if we entered from West, we want to scan N, NE...
  // Let's force initial search to start at 7 (NW) or 0 (N)?
  // If we came from West, we are at P. West is background.
  // Search CW from West: NW, N, NE...
  // West is 6. NW is 7. N is 0.
  // So startDir should be 7.
  // 7 = (6 + 1). (Backtrack + 1).

  // This variable tracks the *direction index* of the "Backtrack" neighbor.
  let checkDirStart = 7;

  let iter = 0;
  const maxIter = width * height * 4;

  while (true) {
    let foundNext = false;

    // Scan neighbors CW starting from checkDirStart
    for (let i = 0; i < 8; i++) {
      const dir = (checkDirStart + i) % 8;
      const nx = pX + dx[dir];
      const ny = pY + dy[dir];

      if (isSet(nx, ny)) {
        // Found next boundary point P_new
        pX = nx;
        pY = ny;
        points.push({ x: pX, y: pY });

        // Update search start for next step.
        // We arrived at P_new from P_old (which was at `dir` FROM P_old? No `dir` is P_old->Neighbor)
        // `dir` is direction P_old -> P_new.
        // The neighbor we "came from" (backtrack) is the one immediately preceding `dir` in the scan?
        // Actually, the new search should start from (Arrival_Vector_Inverse + 1) ?
        // Let's use Moore rule: New search start = (Enter_Direction + 5) % 8? (for 4-conn? different for 8-conn?)

        // Let's use the "Backtrack is previous empty neighbor" rule.
        // The loop checked `dir-1` (conceptually) and it was empty (or we wouldn't be at `dir`).
        // `dir-1` is the neighbor relative to P_old.
        // We need to translate that to P_new frame? Too complex.

        // Simple rule:
        // Arrival Dir `d` (P_old -> P_new).
        // Backtrack for P_new is `(d + 4 + 1)`?
        // Let's use: (d + 5) % 8?
        // Example: Move East (d=2). Arrive at P_new.
        // We want to scan neighbors of P_new.
        // We know West of P_new (Direction 6) is P_old (Set).
        // We want to start scanning from "left" of the way we came in?
        // To hug the "left" wall (outer boundary), we start scanning from the "right" relative to entry?
        // (d + 4) is entry.
        // (d + 4 - 1)?
        // (2 + 4) = 6. 6-1 = 5 (SW).
        // Start scanning at 5?
        // If P_new is (10,10). P_old is (9,10).
        // We check 5 (SW of P_new) -> (9, 11).
        // This seems robust for 8-connectivity.

        checkDirStart = (dir + 5) % 8;

        foundNext = true;
        break;
      }
    }

    if (!foundNext) break; // Isolated point or error
    if (pX === startX && pY === startY) break; // Closed loop

    iter++;
    if (iter > maxIter) break;
  }

  return points;
}

/**
 * Checks if a point is inside a polygon using ray casting algorithm.
 * @param {Object} point - {x, y}
 * @param {Array<Object>} polygon - Array of {x, y}
 * @returns {boolean}
 */
export function isPointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;

    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
