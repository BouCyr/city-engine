import {orderedCellPoints} from "./cell.mjs";

/**
 * Calculate Euclidean distance between two points.
 * @param {Object} p1 - Point with x and y fields.
 * @param {Object} p2 - Point with x and y fields.
 * @returns {number} Distance.
 */
export function distance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate the middle point of two points.
 * @param {Object} p1 - Point with x and y fields.
 * @param {Object} p2 - Point with x and y fields.
 * @returns {Object} Midpoint with x and y fields.
 */
export function midpoint(p1, p2) {
    return {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2
    };
}

/**
 * Calculate small and large angles formed by three points (p1-p2-p3).
 * p2 is the vertex.
 * @param {Object} p1 - Point with x and y fields.
 * @param {Object} p2 - Vertex point with x and y fields.
 * @param {Object} p3 - Point with x and y fields.
 * @returns {Object} Object containing small and large angles in radians.
 */
export function angles(p1, p2, p3) {
    const angle1 = Math.atan2(p1.y - p2.y, p1.x - p2.x);
    const angle3 = Math.atan2(p3.y - p2.y, p3.x - p2.x);

    let diff = Math.abs(angle1 - angle3);

    // Ensure we have the smallest difference
    if (diff > Math.PI) {
        diff = 2 * Math.PI - diff;
    }

    return {
        small: diff,
        large: 2 * Math.PI - diff
    };
}

/**
 * Calculate the centroid of a cell.
 * @param {Object} cell - The cell object.
 * @returns {Object} Centroid with x and y fields.
 */
export function cellCentroid(cell) {
    const points = orderedCellPoints(cell);
    if (points.length === 0) return {x: 0, y: 0};

    let x = 0;
    let y = 0;
    for (const p of points) {
        x += p.x;
        y += p.y;
    }

    return {
        x: x / points.length,
        y: y / points.length
    };
}

/**
 * Find the edge that connects two cells.
 * @param {Object} cellA - The first cell.
 * @param {Object} cellB - The second cell.
 * @returns {Object|null} The edge connecting the two cells, or null if not found.
 */
export function cellsEdge(cellA, cellB) {
    if (!cellA || !cellB) return null;
    return cellA.edges.find(e =>
        (e.leftCell === cellA && e.rightCell === cellB) ||
        (e.leftCell === cellB && e.rightCell === cellA)
    ) || null;
}
