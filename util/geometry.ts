import Delaunator from 'delaunator';
import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector3 } from 'three';
import { ConvexHull } from 'three-stdlib';

import alphaShape from 'alpha-shape';
import alphaComplex from 'alpha-complex';

const convexHull = new ConvexHull();
convexHull.tolerance = 0;
export function bufferHullFromPoints(
    geometry: BufferGeometry,
    points: Vector3[]
) {
    const vertices: number[] = [];
    const normals: number[] = [];
    // convexHull.tolerance = 5;
    convexHull.setFromPoints(points);
    const faces = convexHull.faces;

    // console.log(faces);

    for (let i = 0; i < faces.length; i++) {
        const face = faces[i];
        let edge = face.edge;

        // if (face.constant < 5) continue;

        // we move along a doubly-connected edge list to access all face points (see HalfEdge docs)

        do {
            const point = edge.head().point;

            vertices.push(point.x, point.y, point.z);
            normals.push(face.normal.x, face.normal.y, face.normal.z);

            edge = edge.next;
        } while (edge !== face.edge);
    }

    // build geometry

    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));

    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('normal').needsUpdate=  true;
}

export function bufferDelaunation(geometry: BufferGeometry, points: Vector3[]) {
    const indexDelaunay = Delaunator.from(points.map(v => [v.x, v.y, v.z]));

    // indexDelaunay.triangles.map(t => {
    // })
    const meshIndex: number[] = [];
    indexDelaunay.triangles.forEach(t => {
        meshIndex.push(t);
    })
    geometry.setFromPoints(points);
    geometry.setIndex(meshIndex);
    geometry.computeVertexNormals();
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('normal').needsUpdate=  true;
}

export function bufferAlphaShape(geometry: BufferGeometry, points: Vector3[]) {
    const alpha = alphaComplex(2.0, points.map(v => [v.x, v.y, v.z]));
    const meshIndex: number[] = [];
    alpha.forEach(t => {
        meshIndex.push(...t);
    })
    geometry.setFromPoints(points);
    geometry.setIndex(meshIndex);
    geometry.computeVertexNormals();
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('normal').needsUpdate=  true;
}

export function bufferTriangulateWithHoles(geometry: BufferGeometry, points: Vector3[], holes: Vector3[][]) {
    const faces = ShapeUtils.triangulateShape(points, holes);
    const meshIndex: number[] = [];
    faces.forEach(t => {
        meshIndex.push(...t);
    })
    geometry.setFromPoints(points);
    geometry.setIndex(meshIndex);
    geometry.computeVertexNormals();
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('normal').needsUpdate=  true;
}