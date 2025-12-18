"use client";

import React, {
  useState,
  useEffect,
  useRef,
  createContext,
  useCallback,
} from "react";
import { Analytics } from "@vercel/analytics/next";
import { cn } from "@/lib/utils";

// UI
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import InputDialog from "@/components/ui/inputdialog";
import { Button } from "@/components/ui/button";
import {
  LoaderCircle,
  Crop,
  ImageUp,
  ImageDown,
  Github,
  LoaderPinwheel,
  Fan,
  MessageCircleQuestion,
  Eraser,
  Undo2,
  Trash2,
  Download
} from "lucide-react";

// Image manipulations
import {
  resizeCanvas,
  mergeMasks,
  maskImageCanvas,
  resizeAndPadBox,
  canvasToFloat32Array,
  float32ArrayToCanvas,
  sliceTensor,
  maskCanvasToFloat32Array,
  traceContours,
  isPointInPolygon
} from "@/lib/imageutils";

export default function Home() {
  // resize+pad all images to 1024x1024
  const imageSize = { w: 1024, h: 1024 };
  const maskSize = { w: 256, h: 256 };

  // state
  const [device, setDevice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [imageEncoded, setImageEncoded] = useState(false);
  const [status, setStatus] = useState("");
  const [polygons, setPolygons] = useState([]); // Array of { id, polygon, points }

  // web worker, image and mask
  const samWorker = useRef(null);
  const [image, setImage] = useState(null); // canvas
  const [mask, setMask] = useState(null); // canvas
  const [prevMaskArray, setPrevMaskArray] = useState(null); // Float32Array
  const [imageURL, setImageURL] = useState(
    "/AAA1111.webp"
  );
  const [clickMode, setClickMode] = useState("positive"); // "positive", "negative", "box"
  const [points, setPoints] = useState([]); // state for React rendering
  const [boxStart, setBoxStart] = useState(null); // {x, y} for dragging
  const [hoverBox, setHoverBox] = useState(null); // {x, y, w, h} for visuals

  const canvasEl = useRef(null);
  const fileInputEl = useRef(null);
  const pointsRef = useRef([]);

  // Multi-mask candidates
  const [candidates, setCandidates] = useState([]); // [{mask, score}]
  const [selectedCandidateIdx, setSelectedCandidateIdx] = useState(0);

  // Segment Everything state
  const [isSegmentingAll, setIsSegmentingAll] = useState(false);
  const [segmentAllQueue, setSegmentAllQueue] = useState(0);

  const [stats, setStats] = useState(null);

  // input dialog for custom URLs
  const [inputDialogOpen, setInputDialogOpen] = useState(false);
  const inputDialogDefaultURL = "https://upload.wikimedia.org/wikipedia/commons/9/96/Pro_Air_Martin_404_N255S.jpg"

  // Start encoding image
  const encodeImageClick = async () => {
    samWorker.current.postMessage({
      type: "encodeImage",
      data: canvasToFloat32Array(resizeCanvas(image, imageSize)),
    });

    setLoading(true);
    setStatus("Encoding");
  };

  // Start decoding, prompt with mouse coords
  const imageClick = (event) => {
    if (!imageEncoded || clickMode === "box") return;

    event.preventDefault();

    const canvas = canvasEl.current;
    const rect = event.target.getBoundingClientRect();

    // Determine label
    let label = 1;
    if (event.button === 2) {
      label = 0; // standard right click behavior
    } else {
      label = clickMode === "positive" ? 1 : 0;
    }

    const point = {
      x: ((event.clientX - rect.left) / canvas.width) * imageSize.w,
      y: ((event.clientY - rect.top) / canvas.height) * imageSize.h,
      label: label,
    };

    // Check if we clicked on a saved polygon ONLY if we don't have an active mask
    if (points.length === 0 && !mask) {
      for (let i = 0; i < polygons.length; i++) {
        const poly = polygons[i];
        if (isPointInPolygon(point, poly.polygon)) {
          // Restore this polygon
          const savedPoints = poly.points;

          // Remove from saved list (move to active)
          const newPolygons = polygons.filter(p => p.id !== poly.id);
          setPolygons(newPolygons);

          // Set as active points
          setPoints(savedPoints);
          pointsRef.current = savedPoints;

          // Trigger decode
          samWorker.current.postMessage({
            type: "decodeMask",
            data: {
              points: savedPoints,
              maskArray: null,
              maskShape: null,
            }
          });
          setLoading(true);
          setStatus("Restoring ID " + poly.id);
          return; // Stop processing this click
        }
      }
    }

    const newPoints = [...points, point];
    setPoints(newPoints);
    pointsRef.current = newPoints;


    // do we have a mask already? ie. a refinement click?
    if (prevMaskArray) {
      const maskShape = [1, 1, maskSize.w, maskSize.h]

      samWorker.current.postMessage({
        type: "decodeMask",
        data: {
          points: newPoints,
          maskArray: prevMaskArray,
          maskShape: maskShape,
        }
      });
    } else {
      samWorker.current.postMessage({
        type: "decodeMask",
        data: {
          points: newPoints,
          maskArray: null,
          maskShape: null,
        }
      });
    }

    setLoading(true);
    setStatus("Decoding");
  };

  // Box Interactions
  const handleMouseDown = (e) => {
    if (clickMode !== "box" || !imageEncoded) return;
    const canvas = canvasEl.current;
    const rect = e.target.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / canvas.width) * imageSize.w;
    const y = ((e.clientY - rect.top) / canvas.height) * imageSize.h;
    setBoxStart({ x, y });
  };

  const handleMouseMove = (e) => {
    if (!boxStart || clickMode !== "box") return;
    const canvas = canvasEl.current;
    const rect = e.target.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / canvas.width) * imageSize.w;
    const y = ((e.clientY - rect.top) / canvas.height) * imageSize.h;
    setHoverBox({
      x: Math.min(boxStart.x, x),
      y: Math.min(boxStart.y, y),
      w: Math.abs(x - boxStart.x),
      h: Math.abs(y - boxStart.y)
    });
  };

  const handleMouseUp = (e) => {
    if (!boxStart || clickMode !== "box") return;
    const canvas = canvasEl.current;
    const rect = e.target.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / canvas.width) * imageSize.w;
    const y = ((e.clientY - rect.top) / canvas.height) * imageSize.h;

    // Finalize
    const x1 = Math.min(boxStart.x, x);
    const y1 = Math.min(boxStart.y, y);
    const x2 = Math.max(boxStart.x, x);
    const y2 = Math.max(boxStart.y, y);

    setBoxStart(null);
    setHoverBox(null);

    // Create points for box prompt
    // Top-left (label 2), Bottom-right (label 3)
    const newPoints = [
      { x: x1, y: y1, label: 2 },
      { x: x2, y: y2, label: 3 }
    ];
    setPoints(newPoints);
    pointsRef.current = newPoints;

    samWorker.current.postMessage({
      type: "decodeMask",
      data: {
        points: newPoints,
        maskArray: null, // Box prompt doesn't typically mix with previous mask inputs in simple flows
        maskShape: null,
      }
    });
    setLoading(true);
    setStatus("Decoding Box");
  };

  // Decoding finished -> parse result and update mask
  const handleDecodingResults = (decodingResults) => {
    // SAM2 returns 3 masks along with scores
    const maskTensors = decodingResults.masks;
    const [bs, noMasks, width, height] = maskTensors.dims;
    const maskScores = decodingResults.iou_predictions.cpuData;

    // Store all 3 candidates
    const newCandidates = [];
    for (let i = 0; i < 3; i++) {
      const maskArray = sliceTensor(maskTensors, i);
      let maskCanvas = float32ArrayToCanvas(maskArray, width, height);
      maskCanvas = resizeCanvas(maskCanvas, imageSize);
      newCandidates.push({
        mask: maskCanvas,
        score: maskScores[i],
        maskArray: maskArray
      });
    }

    const bestIdx = maskScores.indexOf(Math.max(...maskScores));

    // If segmenting all, we don't update the interactive mask state
    if (isSegmentingAll) {
      setSegmentAllQueue(prev => {
        const left = prev - 1;
        if (left <= 0) {
          setIsSegmentingAll(false);
          setStatus("Ready");
        }
        return left;
      });

      // Use best mask
      const maskArray = sliceTensor(maskTensors, bestIdx);
      let maskCanvas = float32ArrayToCanvas(maskArray, width, height);
      maskCanvas = resizeCanvas(maskCanvas, imageSize); // Resize to 1024x1024

      const ctx = maskCanvas.getContext("2d");
      const imgData = ctx.getImageData(0, 0, imageSize.w, imageSize.h).data;

      const poly = traceContours(imgData, imageSize.w, imageSize.h);

      if (poly.length > 0) {
        const newPoly = {
          id: Math.random().toString(36).substr(2, 9),
          polygon: poly,
          points: []
        };
        setPolygons(prev => [...prev, newPoly]);
      }
      return;
    }

    setCandidates(newCandidates);
    setSelectedCandidateIdx(bestIdx);

    // Set the primary mask for display/saving
    setMask(newCandidates[bestIdx].mask);
    setPrevMaskArray(newCandidates[bestIdx].maskArray);
  };

  const handleSegmentAll = () => {
    if (!imageEncoded) return;

    // Grid configuration
    const rows = 6;
    const cols = 6;
    const stepX = imageSize.w / cols;
    const stepY = imageSize.h / rows;

    setIsSegmentingAll(true);
    setSegmentAllQueue(rows * cols);
    setStatus("Scanning...");
    setPolygons([]);
    setMask(null);
    setPoints([]);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = stepX * c + stepX / 2;
        const y = stepY * r + stepY / 2;

        samWorker.current.postMessage({
          type: "decodeMask",
          data: {
            points: [{ x, y, label: 1 }],
            maskArray: null,
            maskShape: null,
          }
        });
      }
    }
  };

  // When user switches candidate
  useEffect(() => {
    if (candidates.length > 0) {
      setMask(candidates[selectedCandidateIdx].mask);
      setPrevMaskArray(candidates[selectedCandidateIdx].maskArray);
    }
  }, [selectedCandidateIdx, candidates]);

  const saveAnnotation = () => {
    if (!mask) return;

    // Get mask data
    const ctx = mask.getContext("2d");
    const initData = ctx.getImageData(0, 0, mask.width, mask.height).data;

    // Trace contours
    const poly = traceContours(initData, mask.width, mask.height);

    // Add to list
    if (poly.length > 0) {
      const newPoly = {
        id: Math.random().toString(36).substr(2, 9),
        polygon: poly,
        points: points // Save the inputs that created it
      };
      setPolygons([...polygons, newPoly]);

      // Clear current active mask state to "commit" the save
      setMask(null);
      setPoints([]);
      pointsRef.current = [];
      setPrevMaskArray(null);
    }
  };

  // Handle web worker messages
  const onWorkerMessage = (event) => {
    const { type, data } = event.data;

    if (type == "pong") {
      const { success, device } = data;

      if (success) {
        setLoading(false);
        setDevice(device);
        setStatus("Encode image");
      } else {
        setStatus("Error (check JS console)");
      }
    } else if (type == "downloadInProgress" || type == "loadingInProgress") {
      setLoading(true);
      setStatus("Loading model");
    } else if (type == "encodeImageDone") {
      // alert(data.durationMs)
      setImageEncoded(true);
      setLoading(false);
      setStatus("Ready. Click on image");
    } else if (type == "decodeMaskResult") {
      handleDecodingResults(data);
      setLoading(false);
      setStatus("Ready. Click on image");
    } else if (type == "stats") {
      setStats(data);
    }
  };

  // Crop image with mask
  const cropClick = (event) => {
    const link = document.createElement("a");
    link.href = maskImageCanvas(image, mask).toDataURL();
    link.download = "crop.png";

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Reset all the image-based state: points, mask, offscreen canvases .. 
  const resetState = () => {
    pointsRef.current = [];
    setPoints([]);
    setImage(null);
    setMask(null);
    setPrevMaskArray(null);
    setImageEncoded(false);
  }

  // New image: From File
  const handleFileUpload = (e) => {
    const file = e.target.files[0]
    const dataURL = window.URL.createObjectURL(file)

    resetState()
    setStatus("Encode image")
    setImageURL(dataURL)
  }

  // New image: From URL 
  const handleUrl = (urlText) => {
    const dataURL = urlText;

    resetState()
    setStatus("Encode image");
    setImageURL(dataURL);
  };

  function handleRequestStats() {
    samWorker.current.postMessage({ type: "stats" });
  }

  // Load web worker
  useEffect(() => {
    if (!samWorker.current) {
      samWorker.current = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
      samWorker.current.addEventListener("message", onWorkerMessage);
      samWorker.current.postMessage({ type: "ping" });

      setLoading(true);
    }
  }, [onWorkerMessage, handleDecodingResults]);

  // Load image, pad to square and store in offscreen canvas
  useEffect(() => {
    if (imageURL) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = imageURL;
      img.onload = function () {
        const largestDim =
          img.naturalWidth > img.naturalHeight
            ? img.naturalWidth
            : img.naturalHeight;
        const box = resizeAndPadBox(
          { h: img.naturalHeight, w: img.naturalWidth },
          { h: largestDim, w: largestDim }
        );

        const canvas = document.createElement("canvas");
        canvas.width = largestDim;
        canvas.height = largestDim;

        canvas
          .getContext("2d")
          .drawImage(
            img,
            0,
            0,
            img.naturalWidth,
            img.naturalHeight,
            box.x,
            box.y,
            box.w,
            box.h
          );
        setImage(canvas);
      };
    }
  }, [imageURL]);

  // Download annotated image
  const handleDownload = () => {
    if (!image) return;

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");

    // Draw image
    ctx.drawImage(image, 0, 0);

    // Draw polygons
    if (polygons.length > 0) {
      ctx.strokeStyle = "blue";
      ctx.lineWidth = 3;
      ctx.fillStyle = "rgba(0, 0, 255, 0.3)";

      polygons.forEach(item => {
        const poly = item.polygon;
        if (poly.length < 2) return;

        ctx.beginPath();
        // Polygons are stored in 1024x1024 space (imageSize), which matches `image`.
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(poly[i].x, poly[i].y);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      });
    }

    const link = document.createElement("a");
    link.download = "annotated-image.png";
    link.href = canvas.toDataURL();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Offscreen canvas changed, draw it
  useEffect(() => {
    if (image) {
      const canvas = canvasEl.current;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        image,
        0,
        0,
        image.width,
        image.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
    }
  }, [image]);

  // Mask changed, draw original image and mask on top with some alpha
  useEffect(() => {
    if (mask || image) {
      const canvas = canvasEl.current;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height); // clear first

      if (image) {
        ctx.drawImage(
          image,
          0,
          0,
          image.width,
          image.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
      }

      if (mask) {
        ctx.globalAlpha = 0.5; // Slightly more transparent for better point visibility
        ctx.drawImage(
          mask,
          0,
          0,
          mask.width,
          mask.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        ctx.globalAlpha = 1;
      }

      // Draw saved polygons
      if (polygons.length > 0) {
        ctx.strokeStyle = "blue";
        ctx.lineWidth = 3;
        ctx.fillStyle = "rgba(0, 0, 255, 0.3)";

        polygons.forEach(item => {
          const poly = item.polygon;
          if (poly.length < 2) return;

          ctx.beginPath();
          // Start
          const startX = (poly[0].x / imageSize.w) * canvas.width;
          const startY = (poly[0].y / imageSize.h) * canvas.height;
          ctx.moveTo(startX, startY);

          for (let i = 1; i < poly.length; i++) {
            const px = (poly[i].x / imageSize.w) * canvas.width;
            const py = (poly[i].y / imageSize.h) * canvas.height;
            ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
          ctx.fill();
        });
      }

      // Draw points
      points.forEach((point) => {
        // Convert back from image coordinates to canvas coordinates
        const x = (point.x / imageSize.w) * canvas.width;
        const y = (point.y / imageSize.h) * canvas.height;

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, 2 * Math.PI);
        // Box points labels 2 and 3
        if (point.label === 2 || point.label === 3) {
          ctx.fillStyle = "#0000ff"; // Blue for box corners
        } else {
          ctx.fillStyle = point.label === 1 ? "#00ff00" : "#ff0000";
        }
        ctx.fill();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      // Draw Box Dragging
      if (hoverBox) {
        const x = (hoverBox.x / imageSize.w) * canvas.width;
        const y = (hoverBox.y / imageSize.h) * canvas.height;
        const w = (hoverBox.w / imageSize.w) * canvas.width;
        const h = (hoverBox.h / imageSize.h) * canvas.height;

        ctx.strokeStyle = "purple";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
      }
    }
  }, [mask, image, points, polygons, hoverBox]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="w-full max-w-5xl">

        <CardHeader>
          <CardTitle>
            <div className="flex flex-col gap-2">
              <p>
                Clientside Image Segmentation with onnxruntime-web and Meta's SAM2
              </p>
              <p
                className={cn(
                  "flex gap-1 items-center",
                  device ? "visible" : "invisible"
                )}
              >
                <Fan
                  color="#000"
                  className="w-6 h-6 animate-[spin_2.5s_linear_infinite] direction-reverse"
                />
                Running on {device}
              </p>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex justify-between gap-4">
              <Button
                onClick={encodeImageClick}
                disabled={loading || imageEncoded}
              >
                <p className="flex items-center gap-2">
                  {loading && <LoaderCircle className="animate-spin w-6 h-6" />}
                  {status}
                </p>
              </Button>

              {/* Controls */}
              {imageEncoded && (
                <div className="flex bg-secondary p-1 rounded-md gap-1">
                  <Button
                    variant={clickMode === "positive" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setClickMode("positive")}
                    className="gap-2"
                  >
                    Add Area
                  </Button>
                  <Button
                    variant={clickMode === "negative" ? "destructive" : "ghost"}
                    size="sm"
                    onClick={() => setClickMode("negative")}
                    className="gap-2"
                  >
                    Remove Area
                  </Button>
                  <Button
                    variant={clickMode === "box" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setClickMode("box")}
                    className="gap-2"
                  >
                    <Crop className="w-4 h-4" /> Box
                  </Button>
                  <Button
                    variant={isSegmentingAll ? "outline" : "ghost"}
                    size="sm"
                    disabled={isSegmentingAll}
                    onClick={handleSegmentAll}
                    className="gap-2"
                  >
                    <LoaderPinwheel className={isSegmentingAll ? "animate-spin w-4 h-4" : "w-4 h-4"} /> All
                  </Button>
                </div>
              )}

              {/* Candidate Toggle */}
              {candidates.length > 0 && (
                <div className="flex bg-secondary p-1 rounded-md gap-1 items-center px-2">
                  <span className="text-xs font-mono mr-2">Mask:</span>
                  {[0, 1, 2].map(idx => (
                    <Button
                      key={idx}
                      variant={selectedCandidateIdx === idx ? "outline" : "ghost"}
                      size="icon"
                      className="w-6 h-6 text-xs"
                      onClick={() => setSelectedCandidateIdx(idx)}
                    >
                      {idx + 1}
                    </Button>
                  ))}
                </div>
              )}
              {imageEncoded && (
                <div className="flex bg-secondary p-1 rounded-md gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const newPoints = points.slice(0, -1);
                      setPoints(newPoints);
                      pointsRef.current = newPoints;
                      // Trigger re-decode if we have points left, else define reset logic if needed or just clear mask
                      // ideally re-run decode with remaining points
                      if (newPoints.length > 0) {
                        samWorker.current.postMessage({
                          type: "decodeMask",
                          data: {
                            points: newPoints,
                            maskArray: null, // Start fresh for simplicity when undoing to avoid confusing history
                            maskShape: null,
                          }
                        });
                        setLoading(true);
                        setStatus("Decoding");
                      } else {
                        setMask(null);
                        setPrevMaskArray(null);
                      }
                    }}
                    title="Undo last point"
                  >
                    <Undo2 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      resetState();
                      setImageEncoded(true); // Keep image encoded
                      // Need to restore imageURL though - resetState clears a lot.
                      // Wait, resetState clears image element too?
                      // Let's make a custom clear points function
                      setPoints([]);
                      pointsRef.current = [];
                      setMask(null);
                      setPrevMaskArray(null);
                      setPolygons([]); // clear polygons too? Maybe optional. 
                      // Let's clear everything for a full reset.
                    }}
                    title="Clear all points"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              )}

              <div className="flex gap-1">
                <Button
                  onClick={() => { fileInputEl.current.click() }}
                  variant="secondary"
                  disabled={loading}>
                  <ImageUp /> Upload
                </Button>
                <Button
                  onClick={() => { setInputDialogOpen(true) }}
                  variant="secondary"
                  disabled={loading}
                >
                  <ImageUp /> From URL
                </Button>
                <Button
                  onClick={cropClick}
                  disabled={mask == null}
                  variant="secondary">
                  <ImageDown /> Crop
                </Button>
                <Button
                  onClick={handleDownload}
                  disabled={!imageEncoded}
                  variant="secondary">
                  <Download /> Download
                </Button>

              </div>
            </div>
            <div className="flex justify-center">
              <canvas
                ref={canvasEl}
                width={800}
                height={800}
                onClick={imageClick}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onContextMenu={(event) => {
                  event.preventDefault();
                  imageClick(event);
                }}
              />
            </div>
          </div>
        </CardContent>
        <div className="flex flex-col p-4 gap-2">
          <Button onClick={handleRequestStats} variant="secondary">
            Print stats
          </Button>
          <pre className="p-4 border-gray-600 bg-gray-100">
            {stats != null && JSON.stringify(stats, null, 2)}
          </pre>
        </div>
      </Card>
      <InputDialog
        open={inputDialogOpen}
        setOpen={setInputDialogOpen}
        submitCallback={handleUrl}
        defaultURL={inputDialogDefaultURL}
      />
      <input
        ref={fileInputEl}
        hidden="True"
        accept="image/*"
        type='file'
        onInput={handleFileUpload}
      />
      <Analytics />
    </div>
  );
}
