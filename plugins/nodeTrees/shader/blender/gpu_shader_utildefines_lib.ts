import { glsl } from '../../../../shader/util';

export default glsl`
#ifndef FLT_MAX
#define FLT_MAX 3.402823466e+38
#endif
#ifndef FLT_MIN
#define FLT_MIN 1.175494351e-38
#endif
#ifndef INT_MAX
#define INT_MAX 2147483647
#endif
`;
