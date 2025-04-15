let scene, camera, renderer, controls;
const COORDINATE_SCALE = 0.001; // Scale factor for coordinates

let drillholes = [];
let isTargetMode = false;

// Section slicing variables
let isSectionMode = false;
let sectionPlane = null;
let sectionHelper = null;
let dragControls = null;
let dragObjects = [];

// Create drillhole data manager
const drillhole = new DrillholeData();

let drillholeVisibility = new Map(); // Track visibility of each drillhole

// Function to create simulated topography
function createTopography() {
    console.log('Creating simulated topography...');
    
    // Extract elevation data from collars to use as reference points
    const elevationPoints = [];
    for (const [holeId, collar] of drillhole.collars) {
        elevationPoints.push({
            x: collar.east * COORDINATE_SCALE,
            y: collar.rl,  // Original elevation (without exaggeration)
            z: collar.north * COORDINATE_SCALE
        });
    }
    
    // Get min and max coordinates to define the bounds of the drillhole area
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const point of elevationPoints) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    }
    
    // Add a buffer around the drillhole area (20% of the area size)
    const bufferX = (maxX - minX) * 0.2;
    const bufferZ = (maxZ - minZ) * 0.2;
    minX -= bufferX;
    maxX += bufferX;
    minZ -= bufferZ;
    maxZ += bufferZ;
    
    // Calculate grid dimensions based on the drillhole area
    const gridWidth = maxX - minX;
    const gridDepth = maxZ - minZ;
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    
    // Define resolution - increase for smoother surface
    const gridResolution = 75;  // Increased from 50 to 75
    
    // Create the geometry with the exact dimensions of the drillhole area
    const geometry = new THREE.PlaneGeometry(
        gridWidth, 
        gridDepth, 
        gridResolution, 
        gridResolution
    );
    
    // Find min/max elevation for color mapping
    let minElev = Infinity, maxElev = -Infinity;
    for (const point of elevationPoints) {
        minElev = Math.min(minElev, point.y);
        maxElev = Math.max(maxElev, point.y);
    }
    
    // Add some random variation to min/max for more interesting terrain
    const elevationRange = maxElev - minElev;
    minElev -= elevationRange * 0.05; // Reduced from 0.1 to 0.05
    maxElev += elevationRange * 0.05; // Reduced from 0.1 to 0.05
    
    // Modify the vertices of the plane to create the terrain
    const positions = geometry.attributes.position;
    
    // Store elevation values for contour creation and smoothing
    const elevationValues = [];
    const width = gridResolution + 1;
    const height = gridResolution + 1;
    
    // First pass: calculate raw elevation values
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const z = positions.getY(i);  // Y in the plane geometry is Z in world space
        
        // Transform from local geometry coordinates to world coordinates
        const worldX = x + centerX;
        const worldZ = z + centerZ;
        
        // Calculate elevation using inverse distance weighting
        let elevation = 0;
        let weightSum = 0;
        
        for (const point of elevationPoints) {
            // Calculate distance from this vertex to the elevation point
            const dx = worldX - point.x;
            const dz = worldZ - point.z;
            const distance = Math.sqrt(dx * dx + dz * dz);
            
            // Inverse distance weighting with a lower power factor for smoother transitions
            const power = 1.5; // Reduced from 2 to 1.5 for smoother transitions
            const weight = 1 / Math.pow(distance + 0.5, power); // Increased distance offset for smoother result
            elevation += point.y * weight;
            weightSum += weight;
        }
        
        // If no nearby points, use average elevation
        if (weightSum === 0) {
            elevation = (minElev + maxElev) / 2;
        } else {
            elevation = elevation / weightSum;
        }
        
        // Reduced noise - only 2% of elevation range instead of 5%
        elevation += (Math.random() - 0.5) * elevationRange * 0.02;
        
        // Store the elevation value
        elevationValues[i] = elevation;
    }
    
    // Second pass: apply Gaussian smoothing
    const smoothedElevations = applyGaussianSmoothing(elevationValues, width, height, 2.0);
    
    // Third pass: update vertices with smoothed elevations
    for (let i = 0; i < positions.count; i++) {
        // Apply vertical exaggeration to the smoothed elevation
        const y = -smoothedElevations[i] * VERTICAL_EXAGGERATION * COORDINATE_SCALE;
        
        // Update the vertex
        positions.setZ(i, y);  // Z in the plane geometry is Y in world space
    }
    
    // Update normals
    geometry.computeVertexNormals();
    
    // Create DTM texture
    const dtmTexture = createDTMTexture(smoothedElevations, width, height, minElev, maxElev);
    
    // Create material with DTM texture
    const material = new THREE.MeshPhongMaterial({
        map: dtmTexture,
        side: THREE.DoubleSide,
        flatShading: false, // Smooth shading
        shininess: 0       // No specular highlights
    });
    
    // Create the mesh
    const mesh = new THREE.Mesh(geometry, material);
    
    // Set position to match the grid center
    mesh.position.set(centerX, 0, centerZ);
    
    // Rotate the plane from XY to XZ
    mesh.rotation.x = -Math.PI / 2;
    
    // Return the mesh directly without creating contour lines
    return mesh;
}

// Function to apply Gaussian smoothing to elevation data
function applyGaussianSmoothing(elevationData, width, height, sigma) {
    // Create a copy of the elevation data
    const smoothed = [...elevationData];
    const kernelSize = Math.ceil(sigma * 3) * 2 + 1; // Ensure odd kernel size
    const halfKernel = Math.floor(kernelSize / 2);
    
    // Create Gaussian kernel
    const kernel = [];
    let kernelSum = 0;
    
    for (let y = -halfKernel; y <= halfKernel; y++) {
        for (let x = -halfKernel; x <= halfKernel; x++) {
            const value = Math.exp(-(x*x + y*y) / (2 * sigma * sigma));
            kernel.push(value);
            kernelSum += value;
        }
    }
    
    // Normalize kernel
    for (let i = 0; i < kernel.length; i++) {
        kernel[i] /= kernelSum;
    }
    
    // Apply kernel to elevation data
    const temp = [...elevationData];
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            let sum = 0;
            let weightSum = 0;
            
            // Apply kernel
            for (let ky = -halfKernel; ky <= halfKernel; ky++) {
                for (let kx = -halfKernel; kx <= halfKernel; kx++) {
                    const nx = x + kx;
                    const ny = y + ky;
                    
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const kidx = (ky + halfKernel) * kernelSize + (kx + halfKernel);
                        const nidx = ny * width + nx;
                        sum += temp[nidx] * kernel[kidx];
                        weightSum += kernel[kidx];
                    }
                }
            }
            
            // Assign smoothed value
            smoothed[idx] = sum / weightSum;
        }
    }
    
    return smoothed;
}

// Function to create a DTM texture
function createDTMTexture(elevationData, width, height, minElev, maxElev) {
    console.log('Creating DTM texture...');
    
    // Create a canvas for the texture
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    
    // Calculate elevation range
    const elevationRange = maxElev - minElev;
    
    // Create a color ramp for DTM visualization
    const createColorFromElevation = (elevation) => {
        const normalizedElev = (elevation - minElev) / elevationRange;
        
        // DTM-style color scale
        if (normalizedElev < 0.2) {
            // Blue/green (lowest elevations)
            return {
                r: Math.floor(0),
                g: Math.floor(100 + normalizedElev * 400),
                b: Math.floor(150 + normalizedElev * 400)
            };
        } else if (normalizedElev < 0.4) {
            // Green (low elevations)
            return {
                r: Math.floor(normalizedElev * 250),
                g: Math.floor(200),
                b: Math.floor(50)
            };
        } else if (normalizedElev < 0.6) {
            // Yellow (mid elevations)
            return {
                r: Math.floor(230),
                g: Math.floor(230),
                b: Math.floor(normalizedElev * 100)
            };
        } else if (normalizedElev < 0.8) {
            // Orange/brown (high elevations)
            return {
                r: Math.floor(200),
                g: Math.floor(150 - (normalizedElev - 0.6) * 400),
                b: Math.floor(50)
            };
        } else {
            // Red/white (highest elevations)
            const factor = (normalizedElev - 0.8) * 5; // 0 to 1 for highest 20%
            return {
                r: Math.floor(200 + factor * 55),
                g: Math.floor(100 + factor * 155),
                b: Math.floor(100 + factor * 155)
            };
        }
    };
    
    // Create ImageData for pixel manipulation
    const imageData = context.createImageData(width, height);
    const data = imageData.data;
    
    // Fill the image with colors based on elevation
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const pixelIdx = (y * width + x) * 4;
            
            // Get the elevation value
            const elevation = elevationData[idx];
            
            // Get color for this elevation
            const color = createColorFromElevation(elevation);
            
            // Set pixel color
            data[pixelIdx] = color.r;     // R
            data[pixelIdx + 1] = color.g; // G
            data[pixelIdx + 2] = color.b; // B
            data[pixelIdx + 3] = 255;     // A (fully opaque)
        }
    }
    
    // Put the image data onto the canvas
    context.putImageData(imageData, 0, 0);
    
    // Add grid lines for a more map-like appearance
    const gridSpacing = Math.max(width, height) / 10;
    
    context.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    context.lineWidth = 1;
    
    // Draw grid lines
    for (let x = 0; x < width; x += gridSpacing) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
    }
    
    for (let y = 0; y < height; y += gridSpacing) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
    }
    
    // Create the texture
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    
    return texture;
}

// Function to reload drillhole data
async function reloadDrillholeData() {
    // Clear existing meshes
    drillholes.forEach(mesh => {
        scene.remove(mesh);
    });
    drillholes = [];
    
    // Also remove the topography if it exists
    if (window.topographyMesh) {
        scene.remove(window.topographyMesh);
    }
    
    // Reload data
    const success = await drillhole.loadData();
    if (success) {
        console.log('Creating drillhole meshes...');
        const meshes = drillhole.createDrillholeMeshes();
        console.log('Number of meshes created:', meshes.length);
        
        // Create a bounding box to help with camera positioning
        const bbox = new THREE.Box3();
        meshes.forEach(mesh => {
            // Scale the mesh coordinates
            mesh.scale.set(COORDINATE_SCALE, COORDINATE_SCALE, COORDINATE_SCALE);
            scene.add(mesh);
            bbox.expandByObject(mesh);
            // Add mesh to drillholes array for intersection testing
            drillholes.push(mesh);
        });
        
        // Create and add topography
        window.topographyMesh = createTopography();
        scene.add(window.topographyMesh);
        
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        
        console.log('Scene bounds:', {
            center: { x: center.x, y: center.y, z: center.z },
            size: { x: size.x, y: size.y, z: size.z }
        });
        
        // Calculate camera distance based on scene size
        const maxDim = Math.max(size.x, size.y, size.z);
        const cameraDistance = maxDim * 1.5;
        
        // Position camera
        camera.position.set(
            center.x + cameraDistance,
            center.y + cameraDistance,
            center.z + cameraDistance
        );
        camera.lookAt(center.x, center.y, center.z);

        // Update orbit controls target
        controls.target.copy(center);
        
        // Initialize section controls after data is loaded
        if (typeof initSectionControls === 'function') {
            initSectionControls();
        }
        
        // Update the drillhole table
        updateDrillholeTable();
    }
}

// View direction functions
function setViewDown() {
    // Get the center of the scene
    const bbox = new THREE.Box3();
    drillholes.forEach(mesh => {
        bbox.expandByObject(mesh);
    });
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    
    // Calculate distance for camera
    const maxDim = Math.max(size.x, size.z);
    const distance = maxDim * 2;
    
    // Set camera position looking down (top view)
    const newPosition = new THREE.Vector3(
        center.x,
        center.y + distance,
        center.z
    );
    
    animateCameraMove(newPosition, center);
}

function setViewEast() {
    // Get the center of the scene
    const bbox = new THREE.Box3();
    drillholes.forEach(mesh => {
        bbox.expandByObject(mesh);
    });
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    
    // Calculate distance for camera
    const maxDim = Math.max(size.y, size.z);
    const distance = maxDim * 2;
    
    // Set camera position looking from east (right side view)
    const newPosition = new THREE.Vector3(
        center.x + distance,
        center.y,
        center.z
    );
    
    animateCameraMove(newPosition, center);
}

function setViewNorth() {
    // Get the center of the scene
    const bbox = new THREE.Box3();
    drillholes.forEach(mesh => {
        bbox.expandByObject(mesh);
    });
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    
    // Calculate distance for camera
    const maxDim = Math.max(size.x, size.y);
    const distance = maxDim * 2;
    
    // Set camera position looking from north (front view)
    const newPosition = new THREE.Vector3(
        center.x,
        center.y,
        center.z + distance
    );
    
    animateCameraMove(newPosition, center);
}

// Helper function to animate camera move
function animateCameraMove(newPosition, targetCenter) {
    // Animate camera movement
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    const duration = 1000; // Animation duration in milliseconds
    const startTime = Date.now();

    function animateCamera() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease in-out function for smooth animation
        const easeProgress = progress < 0.5 
            ? 2 * progress * progress 
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        // Interpolate camera position and target
        camera.position.lerpVectors(startPosition, newPosition, easeProgress);
        controls.target.lerpVectors(startTarget, targetCenter, easeProgress);
        
        if (progress < 1) {
            requestAnimationFrame(animateCamera);
        } else {
            // Ensure camera is looking at the center
            camera.lookAt(targetCenter);
            controls.update();
        }
    }

    animateCamera();
}

// Section slicing functions - Modified to stay active
function initSectionControls() {
    console.log('Initializing section controls');
    
    // Create section plane if it doesn't exist
    if (!sectionPlane) {
        createSectionPlane();
    }
    
    // Always enable sectioning
    isSectionMode = true;
    
    // Show section plane
    if (sectionHelper) {
        sectionHelper.visible = true;
    }
    
    // Apply clipping to all relevant meshes
    applyClippingToMeshes(true);
}

function createSectionPlane() {
    // Get scene bounds
    const bbox = new THREE.Box3();
    drillholes.forEach(mesh => {
        bbox.expandByObject(mesh);
    });
    if (window.topographyMesh) {
        bbox.expandByObject(window.topographyMesh);
    }
    
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    
    // Create a vertical plane (EW section) initially
    sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -center.z);
    
    // Add UI for controlling the section plane
    addSectionControls();
    
    return sectionPlane;
}

function addSectionControls() {
    // Create a simple UI for controlling section direction
    const controlsDiv = document.createElement('div');
    controlsDiv.id = 'sectionControls';
    controlsDiv.style.position = 'absolute';
    controlsDiv.style.bottom = '10px';
    controlsDiv.style.left = '10px';
    controlsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    controlsDiv.style.padding = '10px';
    controlsDiv.style.borderRadius = '5px';
    controlsDiv.style.display = 'block'; // Always visible
    
    controlsDiv.innerHTML = `
        <div style="color: white; margin-bottom: 5px;">Section Direction</div>
        <button id="ewSectionBtn" title="East-West Section">E-W</button>
        <button id="nsSectionBtn" title="North-South Section">N-S</button>
        <div style="margin-top: 10px;">
            <input type="range" id="sectionPosition" min="0" max="100" value="50" style="width: 100%;">
        </div>
    `;
    
    document.body.appendChild(controlsDiv);
    
    // Add event listeners for the section controls
    document.getElementById('ewSectionBtn').addEventListener('click', () => {
        setSectionDirection('ew');
    });
    
    document.getElementById('nsSectionBtn').addEventListener('click', () => {
        setSectionDirection('ns');
    });
    
    document.getElementById('sectionPosition').addEventListener('input', (e) => {
        moveSectionPlane(e.target.value);
    });
    
    // Set E-W direction as default
    setSectionDirection('ew');
}

function setSectionDirection(direction) {
    if (!sectionPlane) return;
    
    const bbox = new THREE.Box3();
    drillholes.forEach(mesh => {
        bbox.expandByObject(mesh);
    });
    if (window.topographyMesh) {
        bbox.expandByObject(window.topographyMesh);
    }
    
    const center = bbox.getCenter(new THREE.Vector3());
    
    // Highlight the active button
    document.getElementById('ewSectionBtn').classList.toggle('active', direction === 'ew');
    document.getElementById('nsSectionBtn').classList.toggle('active', direction === 'ns');
    
    if (direction === 'ew') {
        // East-West section (looking north)
        sectionPlane.normal.set(0, 0, 1);
        sectionPlane.constant = -center.z;
        
        // Update the camera to look from the north
        setViewNorth();
    } else if (direction === 'ns') {
        // North-South section (looking east)
        sectionPlane.normal.set(1, 0, 0);
        sectionPlane.constant = -center.x;
        
        // Update the camera to look from the east
        setViewEast();
    }
    
    // Reset slider to middle position
    document.getElementById('sectionPosition').value = 50;
    
    // Update clipping
    applyClippingToMeshes(true);
}

function moveSectionPlane(percentage) {
    if (!sectionPlane) return;
    
    const bbox = new THREE.Box3();
    drillholes.forEach(mesh => {
        bbox.expandByObject(mesh);
    });
    if (window.topographyMesh) {
        bbox.expandByObject(window.topographyMesh);
    }
    
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    
    // Calculate new position based on percentage
    const normalAxis = Math.abs(sectionPlane.normal.x) > 0.5 ? 'x' : 'z';
    
    // Scale to full scene bounds
    const min = center[normalAxis] - size[normalAxis] * 0.7; // Use 70% of size for better visibility
    const max = center[normalAxis] + size[normalAxis] * 0.7;
    const newPos = min + (percentage / 100) * (max - min);
    
    // Update plane constant (the negative of the distance from origin)
    sectionPlane.constant = -newPos;
    
    console.log(`Moving section plane: ${normalAxis} axis, value ${newPos}, constant ${sectionPlane.constant}`);
    
    // Update clipping
    applyClippingToMeshes(true);
}

function applyClippingToMeshes(enable) {
    // Enable renderer clipping
    renderer.localClippingEnabled = enable;
    
    // Apply to drillholes
    drillholes.forEach(group => {
        group.traverse(child => {
            if (child.isMesh) {
                child.material.clippingPlanes = enable ? [sectionPlane] : [];
                child.material.needsUpdate = true;
            }
        });
    });
    
    // Apply to topography mesh
    if (window.topographyMesh) {
        window.topographyMesh.material.clippingPlanes = enable ? [sectionPlane] : [];
        window.topographyMesh.material.needsUpdate = true;
    }
}

// Toggle target mode
function toggleTargetMode() {
    isTargetMode = !isTargetMode;
    const targetBtn = document.getElementById('targetBtn');
    targetBtn.classList.toggle('active', isTargetMode);
}

// Handle click events
function handleClick(event) {
    if (!isTargetMode) return;

    // Calculate mouse position in normalized device coordinates
    const mouse = new THREE.Vector2();
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Create raycaster
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    // Find intersections with drillholes
    const intersects = raycaster.intersectObjects(drillholes, true);

    if (intersects.length > 0) {
        const point = intersects[0].point;
        setRotationCenter(point);
    }
}

// Set the rotation center
function setRotationCenter(point) {
    // Calculate the distance to zoom in (half of the current distance)
    const currentDistance = camera.position.distanceTo(controls.target);
    const zoomDistance = currentDistance * 0.5;

    // Update controls target to the clicked point
    controls.target.copy(point);
    
    // Calculate new camera position
    const direction = new THREE.Vector3().subVectors(camera.position, point).normalize();
    const newPosition = new THREE.Vector3().copy(point).add(direction.multiplyScalar(zoomDistance));
    
    // Animate camera movement
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    const duration = 1000; // Animation duration in milliseconds
    const startTime = Date.now();

    function animateCamera() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease in-out function for smooth animation
        const easeProgress = progress < 0.5 
            ? 2 * progress * progress 
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        // Interpolate camera position
        camera.position.lerpVectors(startPosition, newPosition, easeProgress);
        
        if (progress < 1) {
            requestAnimationFrame(animateCamera);
        }
    }

    animateCamera();
    
    // Disable target mode
    isTargetMode = false;
    document.getElementById('targetBtn').classList.remove('active');
}

// Zoom to extents
function zoomToExtents() {
    // Create a bounding box that contains all drillholes
    const bbox = new THREE.Box3();
    drillholes.forEach(mesh => {
        bbox.expandByObject(mesh);
    });

    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    
    // Calculate camera distance based on scene size
    const maxDim = Math.max(size.x, size.y, size.z);
    const cameraDistance = maxDim * 1.5;
    
    // Calculate new camera position
    const newPosition = new THREE.Vector3(
        center.x + cameraDistance,
        center.y + cameraDistance,
        center.z + cameraDistance
    );

    // Animate camera movement
    const startPosition = camera.position.clone();
    const startTarget = controls.target.clone();
    const duration = 1000; // Animation duration in milliseconds
    const startTime = Date.now();

    function animateCamera() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease in-out function for smooth animation
        const easeProgress = progress < 0.5 
            ? 2 * progress * progress 
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        // Interpolate camera position and target
        camera.position.lerpVectors(startPosition, newPosition, easeProgress);
        controls.target.lerpVectors(startTarget, center, easeProgress);
        
        if (progress < 1) {
            requestAnimationFrame(animateCamera);
        }
    }

    animateCamera();
}

// Add these functions near the top of the file
function toggleTheme() {
    const root = document.documentElement;
    const currentTheme = root.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', newTheme);
    
    // Update theme button icon
    const themeBtn = document.getElementById('themeBtn');
    const themeIcon = themeBtn.querySelector('i');
    themeIcon.className = newTheme === 'light' ? 'fas fa-sun' : 'fas fa-moon';
    
    // Update logo based on theme
    const logo = document.getElementById('logo');
    logo.style.filter = newTheme === 'light' ? 'brightness(0)' : 'brightness(1)';
    
    // Update scene background
    scene.background = new THREE.Color(newTheme === 'light' ? 0xffffff : 0x000000);
}

// Call initSectionControls after data is loaded
async function init() {
    console.log('Initializing scene...');
    
    // Debug: Check if controls panel exists
    const controlsPanel = document.getElementById('controls');
    console.log('Controls panel:', controlsPanel);
    if (controlsPanel) {
        console.log('Controls panel HTML:', controlsPanel.innerHTML);
    }

    // Debug: Check if checkbox exists
    const checkbox = document.getElementById('showTrace');
    console.log('Checkbox:', checkbox);
    
    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Create camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, 100);

    // Create renderer with clipping enabled
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.localClippingEnabled = true; // Enable clipping planes
    document.getElementById('container').appendChild(renderer.domElement);

    // Add orbit controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Add event listeners
    document.getElementById('targetBtn').addEventListener('click', toggleTargetMode);
    document.getElementById('zoomExtentsBtn').addEventListener('click', zoomToExtents);
    document.getElementById('viewDownBtn').addEventListener('click', setViewDown);
    document.getElementById('viewEastBtn').addEventListener('click', setViewEast);
    document.getElementById('viewNorthBtn').addEventListener('click', setViewNorth);
    document.getElementById('toggleTableBtn').addEventListener('click', toggleDrillholeTable);
    renderer.domElement.addEventListener('click', handleClick);

    // Add event listener for drillhole trace visibility
    document.getElementById('showTrace').addEventListener('change', function(e) {
        const showTrace = e.target.checked;
        drillholes.forEach(drillhole => {
            if (drillhole.traceMesh) {
                drillhole.traceMesh.visible = showTrace;
            }
        });
    });

    // Add theme toggle event listener
    document.getElementById('themeBtn').addEventListener('click', toggleTheme);

    // Initial load of drillhole data
    await reloadDrillholeData();
    
    // Hide traces by default
    drillholes.forEach(drillhole => {
        if (drillhole.traceMesh) {
            drillhole.traceMesh.visible = false;
        }
    });
    
    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);

    // Start animation loop
    animate();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function getSceneBounds(scene) {
    const bbox = new THREE.Box3();
    
    // Traverse all objects in the scene
    scene.traverse((object) => {
        if (object.isMesh) {
            bbox.expandByObject(object);
        }
    });
    
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    
    return {
        center: {
            x: center.x,
            y: center.y,
            z: center.z
        },
        size: {
            x: size.x,
            y: size.y,
            z: size.z
        }
    };
}

function updateDrillholeTable() {
    const tableBody = document.getElementById('drillholeTable').querySelector('tbody');
    tableBody.innerHTML = '';
    
    // Get all hole IDs and sort them
    const holeIds = Array.from(drillhole.collars.keys()).sort();
    
    holeIds.forEach(holeId => {
        const row = document.createElement('tr');
        
        // Create HoleID cell with checkbox
        const holeIdCell = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = drillholeVisibility.get(holeId) !== false; // Default to visible
        checkbox.addEventListener('change', (e) => {
            const isVisible = e.target.checked;
            drillholeVisibility.set(holeId, isVisible);
            updateDrillholeVisibility();
        });
        holeIdCell.appendChild(checkbox);
        holeIdCell.appendChild(document.createTextNode(holeId));
        
        // Create Depth cell
        const depthCell = document.createElement('td');
        const collar = drillhole.collars.get(holeId);
        depthCell.textContent = collar ? collar.depth.toFixed(1) + 'm' : 'N/A';
        
        row.appendChild(holeIdCell);
        row.appendChild(depthCell);
        tableBody.appendChild(row);
    });
}

function updateDrillholeVisibility() {
    drillholes.forEach(drillhole => {
        const isVisible = drillholeVisibility.get(drillhole.name) !== false;
        drillhole.visible = isVisible;
    });
}

// Add event listener for the filter input
document.getElementById('drillholeFilter').addEventListener('input', function(e) {
    const filterText = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#drillholeTable tbody tr');
    
    rows.forEach(row => {
        const holeId = row.textContent.trim().toLowerCase();
        row.style.display = holeId.includes(filterText) ? '' : 'none';
    });
});

// Add event listener for the "Select All" checkbox
document.getElementById('selectAll').addEventListener('change', function(e) {
    const isChecked = e.target.checked;
    const checkboxes = document.querySelectorAll('#drillholeTable tbody input[type="checkbox"]');
    
    checkboxes.forEach(checkbox => {
        checkbox.checked = isChecked;
        const holeId = checkbox.parentElement.textContent.trim();
        drillholeVisibility.set(holeId, isChecked);
    });
    
    updateDrillholeVisibility();
});

// Add this new function
function toggleDrillholeTable() {
    const controlsPanel = document.getElementById('controls');
    const isVisible = controlsPanel.style.display !== 'none';
    controlsPanel.style.display = isVisible ? 'none' : 'block';
    
    // Toggle active state of the button
    document.getElementById('toggleTableBtn').classList.toggle('active', !isVisible);
}

// Initialize the scene
init(); 