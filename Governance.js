import * as THREE from 'three';

// --- CONFIGURATION ---
const GOV_STYLES = {
    audit: {
        color: 0x00aaff,
        lineColor: 0x005588,
        hoverColor: 0xffffff
    },
    confidence: {
        high: 0x00ff00,   // High certainty (Green)
        med: 0xffff00,    // Medium certainty (Yellow)
        low: 0xff0000     // Low certainty (Red)
    },
    scenario: {
        baseline: 0x888888, // Grey
        improved: 0x00ff88, // Green
        regressed: 0xff3333 // Red
    },
    text: {
        font: 'bold 24px Arial',
        color: 'white',
        bg: 'rgba(0,0,0,0.8)'
    }
};

export class GovernanceLayer {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera; // Needed for text sprites to face user

        // Groups
        this.layers = {
            audit: new THREE.Group(),
            confidence: new THREE.Group(),
            scenario: new THREE.Group()
        };

        // Add groups to scene
        Object.values(this.layers).forEach(g => this.scene.add(g));

        // State
        this.auditLog = [];
        this.lastAuditPos = null; // To draw connecting lines
        this.raycaster = new THREE.Raycaster();
    }

    // ==========================================
    // 1. AUDIT TRAIL (Traceability & History)
    // ==========================================
    
    /**
     * Logs a user action visually and historically.
     * @param {string} type - 'OPTIMIZE', 'FILTER', 'POLICY_CHANGE'
     * @param {THREE.Vector3} position - World coordinates
     * @param {object} metadata - Details (User ID, Timestamp, Values)
     */
    logInteraction(type, position, metadata) {
        const timestamp = new Date();
        const record = { id: Date.now(), type, position: position.clone(), metadata, time: timestamp };
        this.auditLog.push(record);

        // 1. Geometry based on Action Type
        let geometry;
        switch (type) {
            case 'OPTIMIZE': geometry = new THREE.BoxGeometry(0.4, 0.4, 0.4); break; // Cube
            case 'POLICY_CHANGE': geometry = new THREE.ConeGeometry(0.3, 0.6, 4); break; // Pyramid
            default: geometry = new THREE.SphereGeometry(0.25, 16, 16); // Sphere
        }

        // 2. Create Marker
        const material = new THREE.MeshPhongMaterial({ 
            color: GOV_STYLES.audit.color, 
            emissive: 0x002244,
            transparent: true, 
            opacity: 0.9 
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(position);
        mesh.position.y += 1.0; // Float above ground
        
        // Metadata for raycasting interactions
        mesh.userData = { type: 'AUDIT_MARKER', record: record };
        this.layers.audit.add(mesh);

        // 3. Draw Timeline Connection (The "Thread" of decision making)
        if (this.lastAuditPos) {
            const points = [this.lastAuditPos, mesh.position];
            const curve = new THREE.CatmullRomCurve3(points);
            const lineGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(20));
            const lineMat = new THREE.LineDashedMaterial({ 
                color: GOV_STYLES.audit.lineColor, 
                dashSize: 0.2, 
                gapSize: 0.1, 
                transparent: true, 
                opacity: 0.5 
            });
            const line = new THREE.Line(lineGeo, lineMat);
            line.computeLineDistances();
            this.layers.audit.add(line);
        }
        
        // 4. Drop anchor line to ground
        const anchorGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0), new THREE.Vector3(0, -1.0, 0)
        ]);
        const anchorLine = new THREE.Line(anchorGeo, new THREE.LineBasicMaterial({ color: 0x555555 }));
        mesh.add(anchorLine);

        this.lastAuditPos = mesh.position.clone();
        this._animateEntry(mesh);
        
        console.log(`[GOV] Logged: ${type}`, record);
    }

    // ==========================================
    // 2. CONFIDENCE INTERVALS (Uncertainty)
    // ==========================================

    /**
     * Renders probability density shells (1-sigma, 2-sigma, 3-sigma).
     * @param {Array} dataPoints - { position: Vector3, uncertainty: 0.0-1.0 }
     */
    showConfidenceIntervals(dataPoints) {
        this._clearGroup(this.layers.confidence);

        dataPoints.forEach(pt => {
            const uncertainty = pt.uncertainty || 0.1; // 0.1 = precise, 0.9 = very uncertain
            
            // Color mapping: Green (Precise) -> Red (Uncertain)
            const color = new THREE.Color().lerpColors(
                new THREE.Color(GOV_STYLES.confidence.high),
                new THREE.Color(GOV_STYLES.confidence.low),
                uncertainty
            );

            // Render 3 concentric shells to represent Statistical Deviation
            // Inner (Dense), Middle, Outer (Faint)
            [0.3, 0.6, 1.0].forEach((scale, i) => {
                const radius = (uncertainty * 5.0 + 0.5) * scale;
                const opacity = (1.0 - scale) * 0.4 + 0.1; // Inner is more opaque

                const geo = new THREE.SphereGeometry(radius, 32, 16);
                const mat = new THREE.MeshBasicMaterial({
                    color: color,
                    transparent: true,
                    opacity: opacity,
                    depthWrite: false, // Important for nesting transparency
                    wireframe: i === 2 // Outermost is wireframe
                });
                const shell = new THREE.Mesh(geo, mat);
                shell.position.copy(pt.position);
                this.layers.confidence.add(shell);
            });

            // Label the uncertainty
            const label = this._createTextLabel(`±${(uncertainty*100).toFixed(0)}% Var`);
            label.position.copy(pt.position);
            label.position.y += (uncertainty * 5.0) + 1;
            this.layers.confidence.add(label);
        });
    }

    // ==========================================
    // 3. SCENARIO COMPARISON (Fairness & Delta)
    // ==========================================

    /**
     * Visualizes the difference between Baseline and Proposed scenarios.
     * Includes delta labels (e.g., "+15%").
     * @param {Array} comparisonData - Objects with { position, baselineVal, proposedVal, metricName }
     */
    compareScenarios(comparisonData) {
        this._clearGroup(this.layers.scenario);

        comparisonData.forEach(d => {
            const isImprovement = d.proposedVal > d.baselineVal; // Assume higher is better for now
            const delta = d.proposedVal - d.baselineVal;
            const pctChange = ((delta / d.baselineVal) * 100).toFixed(1);
            
            const color = isImprovement ? GOV_STYLES.scenario.improved : GOV_STYLES.scenario.regressed;

            // 1. Render Baseline (Ghost Wireframe)
            const baseGeo = new THREE.BoxGeometry(0.5, d.baselineVal, 0.5);
            const baseMat = new THREE.MeshBasicMaterial({ color: GOV_STYLES.scenario.baseline, wireframe: true, transparent: true, opacity: 0.3 });
            const baseMesh = new THREE.Mesh(baseGeo, baseMat);
            baseMesh.position.set(d.position.x, d.baselineVal/2, d.position.z);
            this.layers.scenario.add(baseMesh);

            // 2. Render Proposed (Solid)
            const propGeo = new THREE.BoxGeometry(0.4, d.proposedVal, 0.4);
            const propMat = new THREE.MeshPhongMaterial({ color: color, transparent: true, opacity: 0.8 });
            const propMesh = new THREE.Mesh(propGeo, propMat);
            propMesh.position.set(d.position.x, d.proposedVal/2, d.position.z);
            this.layers.scenario.add(propMesh);

            // 3. Delta Connector Line (If there's a difference)
            if (Math.abs(delta) > 0.1) {
                const lineGeo = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(d.position.x, d.baselineVal, d.position.z),
                    new THREE.Vector3(d.position.x, d.proposedVal, d.position.z)
                ]);
                const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
                this.layers.scenario.add(line);

                // 4. Floating Delta Label
                const symbol = isImprovement ? '▲' : '▼';
                const labelText = `${symbol} ${pctChange}%`;
                const label = this._createTextLabel(labelText, isImprovement ? 'rgba(0,100,0,0.8)' : 'rgba(100,0,0,0.8)');
                
                // Position at the taller of the two bars
                const maxY = Math.max(d.baselineVal, d.proposedVal);
                label.position.set(d.position.x, maxY + 0.5, d.position.z);
                this.layers.scenario.add(label);
            }
        });
    }

    // ==========================================
    // UTILITIES
    // ==========================================

    toggleLayer(layerName, isVisible) {
        if (this.layers[layerName]) {
            this.layers[layerName].visible = isVisible;
        }
    }

    // Interactive helper: pass mouse/camera to see if we clicked an audit marker
    getIntersections(mouse, camera) {
        if (!this.layers.audit.visible) return [];
        
        this.raycaster.setFromCamera(mouse, camera);
        const intersects = this.raycaster.intersectObjects(this.layers.audit.children, true);
        
        // Filter for objects that have audit records
        return intersects
            .map(hit => hit.object.userData.record ? hit.object.userData.record : hit.object.parent?.userData.record)
            .filter(r => r !== undefined);
    }

    _createTextLabel(text, bgColor = GOV_STYLES.text.bg) {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 128;
        const ctx = canvas.getContext('2d');
        
        // Background Pill
        ctx.fillStyle = bgColor;
        if(ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(10, 30, 236, 68, 20); ctx.fill();
        } else {
            ctx.fillRect(10, 30, 236, 68);
        }

        // Text
        ctx.font = GOV_STYLES.text.font;
        ctx.fillStyle = GOV_STYLES.text.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 128, 64);

        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
        sprite.scale.set(2, 1, 1);
        return sprite;
    }

    _clearGroup(group) {
        while(group.children.length > 0) {
            const obj = group.children[0];
            if(obj.geometry) obj.geometry.dispose();
            if(obj.material) obj.material.dispose();
            group.remove(obj);
        }
    }

    _animateEntry(mesh) {
        mesh.scale.set(0,0,0);
        let s = 0;
        const animate = () => {
            s += 0.1;
            mesh.scale.setScalar(s);
            if (s < 1) requestAnimationFrame(animate);
        };
        animate();
    }
}
