export const glsl = (r: TemplateStringsArray, ...expr: any[]) => {
    let str = r[0];
    for (let i = 0; i < expr.length; i++) {
        str += expr[i] + r[i + 1];
    }

    return str;
};
export const vert = glsl;
export const frag = glsl;
