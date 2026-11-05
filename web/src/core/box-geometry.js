// 边界框几何判断。

export function isOverlapping(r1, r2) {
    return !(
        r1.x + r1.w < r2.x ||
        r1.x > r2.x + r2.w ||
        r1.y + r1.h < r2.y ||
        r1.y > r2.y + r2.h
    );
}
