// Constants
const VERTICAL_EXAGGERATION = 5;  // Reduced from 10 to 5
const TUBE_RADIUS = 2.0;
const GEOLOGY_TUBE_RADIUS = 4.0;
const LINE_WIDTH = 2;
const LABEL_OFFSET = 5;

class DrillholeData {
    constructor() {
        this.collars = new Map();
        this.surveys = new Map();
        this.geology = new Map();
        this.loaded = false;
    }

    async loadData() {
        try {
            console.log('Loading CSV files...');
            
            // Load collar data
            const collarResponse = await fetch('Data/CollarTest.csv');
            const collarText = await collarResponse.text();
            const collarData = Papa.parse(collarText, { header: true, skipEmptyLines: true });
            console.log(`Loaded ${collarData.data.length} collar records`);
            
            // Process collar data
            collarData.data.forEach(row => {
                if (row.HOLEID && row.EAST && row.NORTH && row.RL && row.DEPTH) {
                    this.collars.set(row.HOLEID, {
                        east: parseFloat(row.EAST),
                        north: parseFloat(row.NORTH),
                        rl: parseFloat(row.RL),
                        depth: parseFloat(row.DEPTH)
                    });
                }
            });
            console.log(`Processed ${this.collars.size} collar records`);

            // Load survey data
            const surveyResponse = await fetch('Data/SurveyTest.csv');
            const surveyText = await surveyResponse.text();
            const surveyData = Papa.parse(surveyText, { header: true, skipEmptyLines: true });
            console.log(`Loaded ${surveyData.data.length} survey records`);
            
            // Process survey data
            surveyData.data.forEach(row => {
                if (row.HOLEID && row.DEPTH && row.AZIMUTH && row.DIP) {
                    if (!this.surveys.has(row.HOLEID)) {
                        this.surveys.set(row.HOLEID, []);
                    }
                    this.surveys.get(row.HOLEID).push({
                        depth: parseFloat(row.DEPTH),
                        azimuth: parseFloat(row.AZIMUTH),
                        dip: parseFloat(row.DIP)
                    });
                }
            });
            console.log(`Processed ${this.surveys.size} survey records`);

            // Load geology data
            const geologyResponse = await fetch('Data/GeologyTest.csv');
            const geologyText = await geologyResponse.text();
            const geologyData = Papa.parse(geologyText, { header: true, skipEmptyLines: true });
            console.log(`Loaded ${geologyData.data.length} geology records`);
            
            // Process geology data
            geologyData.data.forEach(row => {
                if (row.HOLEID && row.FROM && row.TO && row.ABBRV) {
                    if (!this.geology.has(row.HOLEID)) {
                        this.geology.set(row.HOLEID, []);
                    }
                    const code = row.ABBRV.trim().toUpperCase();
                    this.geology.get(row.HOLEID).push({
                        from: parseFloat(row.FROM),
                        to: parseFloat(row.TO),
                        code: code
                    });
                }
            });
            console.log(`Processed ${this.geology.size} geology records`);

            // Log geology data for debugging
            this.geology.forEach((intervals, holeId) => {
                console.log(`Geology for ${holeId}:`, intervals);
            });

            // Sort survey points by depth for each hole
            for (const [holeId, survey] of this.surveys.entries()) {
                survey.sort((a, b) => a.depth - b.depth);
            }
            
            this.loaded = true;
            return true;
        } catch (error) {
            console.error('Error loading data:', error);
            return false;
        }
    }

    // Get geology code for a specific depth in a hole
    getGeologyAtDepth(holeId, depth) {
        const geologyIntervals = this.geology.get(holeId);
        if (!geologyIntervals) return 'UNK'; // Unknown geology

        for (const interval of geologyIntervals) {
            if (depth >= interval.from && depth < interval.to) {
                return interval.code;
            }
        }
        return 'UNK'; // Unknown geology if depth is outside all intervals
    }

    createDrillholeGeometry(holeId) {
        const collar = this.collars.get(holeId);
        const survey = this.surveys.get(holeId);
        
        if (!collar) {
            console.warn(`No collar data for hole ${holeId}`);
            return null;
        }

        // Create points array for the drillhole path
        const points = [];
        
        // Add collar point
        points.push(new THREE.Vector3(
            collar.east,
            -collar.rl * VERTICAL_EXAGGERATION,  // Apply vertical exaggeration to collar
            collar.north
        ));

        if (survey && survey.length > 0) {
            // Sort survey points by depth
            survey.sort((a, b) => a.depth - b.depth);
            
            // Add survey points, skipping the SET-UP point
            for (let i = 0; i < survey.length; i++) {
                const point = survey[i];
                if (point.depth > 0) {  // Skip SET-UP point (depth = 0)
                    const position = this.calculatePosition(collar, point);
                    position.y *= VERTICAL_EXAGGERATION;  // Apply vertical exaggeration
                    points.push(position);
                }
            }
        } else {
            // If no survey data, create a vertical line
            points.push(new THREE.Vector3(
                collar.east,
                (-collar.rl + collar.depth) * VERTICAL_EXAGGERATION,  // Apply vertical exaggeration to end point
                collar.north
            ));
        }

        // Create curve and geometry
        const curve = new THREE.CatmullRomCurve3(points);
        const geometry = new THREE.TubeGeometry(curve, points.length * 2, TUBE_RADIUS, 8, false);
        
        return { geometry, curve };
    }

    calculatePosition(collar, surveyPoint) {
        // Convert angles to radians
        const azimuthRad = THREE.MathUtils.degToRad(surveyPoint.azimuth);
        const dipRad = THREE.MathUtils.degToRad(surveyPoint.dip);
        
        // Calculate displacement from collar
        // For a dip of -20 degrees:
        // - Horizontal component (cos) should be larger than vertical component (sin)
        // - Negative dip means going downward
        const dx = surveyPoint.depth * Math.cos(dipRad) * Math.sin(azimuthRad);
        const dy = surveyPoint.depth * Math.sin(dipRad);  // Negative dip means negative dy
        const dz = surveyPoint.depth * Math.cos(dipRad) * Math.cos(azimuthRad);
        
        // Return new position
        return new THREE.Vector3(
            collar.east + dx,
            -collar.rl + dy,  // Note: y is already negative for RL
            collar.north + dz
        );
    }

    createDrillholeMeshes() {
        const meshes = [];
        let tubeCount = 0;
        let lineCount = 0;
        let holesWithData = 0;
        let holesWithoutData = 0;

        // Create text sprite material
        const createTextSprite = (text) => {
            console.log(`Creating label for ${text}`);
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = 512;  // Increased canvas size
            canvas.height = 128;

            // Set font style
            context.fillStyle = 'black';  // Add background
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.font = 'Bold 64px Arial';  // Larger font
            context.fillStyle = 'yellow';  // Brighter text color
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            
            // Add text to canvas
            context.fillText(text, canvas.width / 2, canvas.height / 2);
            
            // Create texture
            const texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;  // Ensure texture updates

            const spriteMaterial = new THREE.SpriteMaterial({ 
                map: texture,
                transparent: true,
                opacity: 0.8
            });

            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(100, 25, 1);  // Adjusted scale
            return sprite;
        };

        // Determine if this is a tube or line visualization
        // For this example, we'll create both types for demonstration
        // In a real application, this might be a user setting or based on the data
        
        // Create a group for each drillhole
        for (const [holeId, collar] of this.collars) {
            const group = new THREE.Group();
            group.name = holeId;

            console.log(`Processing drillhole ${holeId}`);

            // Create the main drillhole geometry and curve
            const result = this.createDrillholeGeometry(holeId);
            if (!result) continue;
            const { geometry, curve } = result;
            
            // Get survey data for this hole
            const survey = this.surveys.get(holeId);
            const hasSurvey = survey && survey.length > 0;

            // Create tube geometry (showing as semi-transparent tube)
            const tubeMaterial = new THREE.MeshPhongMaterial({
                color: 0xffa500, // Orange color
                transparent: true,
                opacity: hasSurvey ? 0.3 : 0.1  // Make main tube more transparent to see geology intervals
            });

            // Create the main drillhole tube mesh
            const tubeMesh = new THREE.Mesh(geometry, tubeMaterial);
            group.add(tubeMesh);
            tubeCount++;

            // Also create a line representation
            if (curve) {
                const points = curve.getPoints(50); // Get points along the curve
                const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
                const lineMaterial = new THREE.LineBasicMaterial({ 
                    color: 0x3333ff, // Blue color
                    linewidth: LINE_WIDTH,
                    opacity: hasSurvey ? 0.7 : 0.3,
                    transparent: true
                });
                const lineMesh = new THREE.Line(lineGeometry, lineMaterial);
                group.add(lineMesh);
                group.traceMesh = lineMesh; // Store the line mesh for easy access
                lineCount++;
            }

            if (hasSurvey) {
                holesWithData++;
            } else {
                holesWithoutData++;
            }

            // Add geology intervals if available
            const geologyIntervals = this.geology.get(holeId);
            if (geologyIntervals && curve) {
                console.log(`Hole ${holeId} has ${geologyIntervals.length} geology intervals`);
                
                // Create survey depth array
                const surveyDepths = [];
                if (survey && survey.length > 0) {
                    for (const point of survey) {
                        surveyDepths.push(point.depth);
                    }
                }
                surveyDepths.push(collar.depth); // Add the EOH (End Of Hole) depth
                
                // Process each geology interval
                for (const interval of geologyIntervals) {
                    console.log(`Processing interval: ${interval.from}m to ${interval.to}m, Code: ${interval.code}`);
                    
                    // Create points array for this interval
                    const intervalPoints = [];
                    
                    // Add the start point
                    const startPoint = this.getPointAtDepth(holeId, interval.from);
                    if (startPoint) {
                        startPoint.y *= VERTICAL_EXAGGERATION;
                        intervalPoints.push(startPoint);
                    }
                    
                    // Add intermediate points within this interval that match survey points
                    for (const surveyDepth of surveyDepths) {
                        if (surveyDepth > interval.from && surveyDepth < interval.to) {
                            const intermediatePoint = this.getPointAtDepth(holeId, surveyDepth);
                            if (intermediatePoint) {
                                intermediatePoint.y *= VERTICAL_EXAGGERATION;
                                intervalPoints.push(intermediatePoint);
                            }
                        }
                    }
                    
                    // Add additional intermediate points for smoother curves
                    const step = Math.max(5, (interval.to - interval.from) / 10); // At least one point every 5m
                    for (let depth = interval.from + step; depth < interval.to; depth += step) {
                        // Skip if we're too close to a survey point we already added
                        const isTooCloseToSurvey = surveyDepths.some(sd => Math.abs(depth - sd) < step / 2);
                        if (!isTooCloseToSurvey) {
                            const intermediatePoint = this.getPointAtDepth(holeId, depth);
                            if (intermediatePoint) {
                                intermediatePoint.y *= VERTICAL_EXAGGERATION;
                                intervalPoints.push(intermediatePoint);
                            }
                        }
                    }
                    
                    // Add the end point
                    const endPoint = this.getPointAtDepth(holeId, interval.to);
                    if (endPoint) {
                        endPoint.y *= VERTICAL_EXAGGERATION;
                        intervalPoints.push(endPoint);
                    }
                    
                    // Sort points by depth (distance from collar)
                    intervalPoints.sort((a, b) => {
                        const depthA = this.getDepthFromPoint(holeId, a);
                        const depthB = this.getDepthFromPoint(holeId, b);
                        return depthA - depthB;
                    });
                    
                    if (intervalPoints.length >= 2) {
                        console.log(`Creating geology tube for interval with ${intervalPoints.length} points`);
                        
                        // Create tube geometry for the interval
                        const intervalCurve = new THREE.CatmullRomCurve3(intervalPoints);
                        const tubeGeometry = new THREE.TubeGeometry(
                            intervalCurve,
                            Math.max(6, intervalPoints.length * 2), // Ensure enough segments
                            GEOLOGY_TUBE_RADIUS, 
                            8, // Radial segments
                            false // Not closed
                        );
                        
                        // Set color based on geology code
                        let color;
                        switch (interval.code) {
                            case 'OX':
                                color = 0xffa500; // Orange
                                break;
                            case 'FR':
                                color = 0x00ff00; // Green
                                break;
                            case 'BR':
                                color = 0x8b4513; // Brown
                                break;
                            default:
                                color = 0x808080; // Gray for unknown
                        }
                        
                        const geologyMaterial = new THREE.MeshPhongMaterial({
                            color: color,
                            transparent: true,
                            opacity: 0.9
                        });
                        
                        const geologyMesh = new THREE.Mesh(tubeGeometry, geologyMaterial);
                        group.add(geologyMesh);
                        
                        // Also create a line representation for the geology interval
                        const lineGeometry = new THREE.BufferGeometry().setFromPoints(intervalPoints);
                        const lineMaterial = new THREE.LineBasicMaterial({
                            color: color,
                            linewidth: LINE_WIDTH * 2, // Make geology lines thicker
                            transparent: true,
                            opacity: 0.8
                        });
                        const lineMesh = new THREE.Line(lineGeometry, lineMaterial);
                        group.add(lineMesh);
                    } else {
                        console.warn(`Not enough points to create geology tube for interval ${interval.from}m to ${interval.to}m`);
                    }
                }
            }

            // Add hole ID label
            const label = createTextSprite(holeId);
            const collarPoint = this.getPointAtDepth(holeId, 0);
            if (collarPoint) {
                // Apply vertical exaggeration to label position
                collarPoint.y *= VERTICAL_EXAGGERATION;
                label.position.copy(collarPoint);
                label.position.y += 5; // Offset above the collar
                group.add(label);
            }
            
            meshes.push(group);
        }
        
        console.log(`Created ${tubeCount} tube geometries, ${lineCount} line geometries`);
        console.log(`Holes with survey data: ${holesWithData}, without survey data: ${holesWithoutData}`);
        return meshes;
    }

    // Helper method to get depth from a point
    getDepthFromPoint(holeId, point) {
        const collar = this.collars.get(holeId);
        if (!collar) return null;
        
        // Simple approximation based on vertical distance
        const verticalDistance = (-point.y / VERTICAL_EXAGGERATION) - (-collar.rl);
        return verticalDistance;
    }

    // Helper method to get point at specific depth
    getPointAtDepth(holeId, depth) {
        const collar = this.collars.get(holeId);
        const survey = this.surveys.get(holeId);
        
        if (!collar) {
            console.warn(`No collar data for hole ${holeId}`);
            return null;
        }
        
        if (!survey || survey.length === 0) {
            // For vertical holes
            return new THREE.Vector3(
                collar.east,
                -collar.rl + depth,  // Invert RL and add depth to go down
                collar.north
            );
        }

        // Calculate the point position based on survey data
        let currentPoint = new THREE.Vector3(collar.east, -collar.rl, collar.north);  // Invert initial RL
        let currentDepth = 0;
        
        // Find the relevant survey segment
        for (let i = 0; i < survey.length; i++) {
            const currentSurvey = survey[i];
            const nextSurvey = survey[i + 1];
            const segmentEndDepth = nextSurvey ? nextSurvey.depth : collar.depth;
            
            // If target depth is in this segment
            if (depth <= segmentEndDepth || i === survey.length - 1) {
                const azimuthRad = THREE.MathUtils.degToRad(currentSurvey.azimuth);
                const dipRad = THREE.MathUtils.degToRad(currentSurvey.dip);
                
                // Calculate the remaining distance to the target depth
                const remainingLength = depth - currentDepth;
                
                // Calculate the displacement
                const dx = remainingLength * Math.cos(dipRad) * Math.sin(azimuthRad);
                const dy = remainingLength * Math.sin(dipRad);  // Negative dip means negative dy
                const dz = remainingLength * Math.cos(dipRad) * Math.cos(azimuthRad);
                
                // Return the final point
                return new THREE.Vector3(
                    currentPoint.x + dx,
                    currentPoint.y + dy,
                    currentPoint.z + dz
                );
            }
            
            // Move to the next segment
            if (nextSurvey) {
                const segmentLength = nextSurvey.depth - currentSurvey.depth;
                const azimuthRad = THREE.MathUtils.degToRad(currentSurvey.azimuth);
                const dipRad = THREE.MathUtils.degToRad(currentSurvey.dip);
                
                // Calculate the displacement for this segment
                const dx = segmentLength * Math.cos(dipRad) * Math.sin(azimuthRad);
                const dy = segmentLength * Math.sin(dipRad);  // Negative dip means negative dy
                const dz = segmentLength * Math.cos(dipRad) * Math.cos(azimuthRad);
                
                // Update current point and depth
                currentPoint.x += dx;
                currentPoint.y += dy;
                currentPoint.z += dz;
                currentDepth = nextSurvey.depth;
            }
        }
        
        // If we get here, something went wrong
        console.warn(`Could not calculate point for depth ${depth}m in hole ${holeId}`);
        return null;
    }

    getGeologyColor(code) {
        switch (code) {
            case 'OX':
                return 0xffa500; // Orange
            case 'FR':
                return 0x00ff00; // Green
            case 'BR':
                return 0x8b4513; // Brown
            default:
                return 0x808080; // Gray for unknown
        }
    }
} 