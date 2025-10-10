# bl_info = {
#     "name": "Move X Axis",
#     "blender": (2, 80, 0),
#     "category": "Object",
# }

import bpy

def prepareAttributesForExport(object):
    if not hasattr(object, 'modifiers'): return False

    evaluated_object = object.evaluated_get(bpy.context.evaluated_depsgraph_get())
    # if not 'attributes' in evaluated_object:
    #     print('[WARN Sprixle.Export] no attributes in', object.name, evaluated_object)
    #     return

    def exportAttribute(name):
        attribute = evaluated_object.data.attributes[name]

        values = []
        values = [str(attr.value) for attr in attribute.data]

        print('[Sprixle.Export Attribute]', object.name, ':', name,'=', values)
        object[name + '+attribute'] = f"[{','.join(values)}]"

    for modifier in object.modifiers:
        if not hasattr(modifier, 'node_group') or not modifier.node_group: continue
        if modifier.node_group.name == 'Sprixle: Export Attribute':
            exportAttribute(modifier['Socket_2'])
            
            continue

        node_group = modifier.node_group

        for node in node_group.nodes:
            if not node.type == 'GROUP' or not node.node_tree.name == 'Sprixle: Export Attribute': continue

            if (node.inputs[1].is_linked):
                raise LookupError('Sprixle: Export Attribute node doesn\'t support linked Name parameter.')
            exportAttribute(node.inputs[1].default_value)
    
        # print('baking', object, modifier)
        

        

def prepareInstancesForExport(object):
    if not hasattr(object, 'modifiers'): return False

    for modifier in object.modifiers:
        if not hasattr(modifier, 'node_group') or not modifier.node_group or not modifier.node_group.name == 'Sprixle: Export Instances': continue
    
        # print('baking', object, modifier)
        print('[Sprixle.Export] instances for', object.name)

        modifier["Socket_2"] = False
        modifier.show_viewport = True

        evaluated_object = object.evaluated_get(bpy.context.evaluated_depsgraph_get())

        object['+instances'] = 0

        for attribute_name in evaluated_object.data.attributes.keys():
            if attribute_name.startswith('.'): continue
            if attribute_name == 'UVMap': continue
            attribute = evaluated_object.data.attributes[attribute_name]
            if attribute_name == 'position': 
                object['+instances'] = len(attribute.data)
                continue
            if attribute_name == 'id': continue

            values = []
            if isinstance(attribute, bpy.types.FloatVectorAttribute):
                values = (f"[{','.join(str(i) for i in [attr.vector[0], attr.vector[2], attr.vector[1]])}]" for attr in attribute.data)
            elif isinstance(attribute, bpy.types.Float4x4Attribute):
                matrices = [list(attr.value) for attr in attribute.data]
                for index in range(len(matrices)):
                    matrix = [list(matrixRow) for matrixRow in list(matrices[index])]

                    # matrix = z_up_to_y_up(matrix)

                    # z = matrix[2]
                    # matrix[2] = matrix[1]
                    # matrix[1] = z

                    for mRow in matrix:
                        for mValue in mRow:
                            values.append(str(mValue))
                
            else:
                values = (attr.value for attr in attribute.data)

            object[attribute_name + '+attribute'] = f"[{','.join(values)}]"

        # enable serialized so geometry gets output in gltf export
        modifier["Socket_2"] = True
        modifier.show_render = True

        return True

    return False
     
def cleanupInstanceExport(object):
    if not hasattr(object, 'modifiers'): return

    for modifier in object.modifiers:
        if not modifier.node_group.name == 'Sprixle: Export Instances': continue
    
        modifier["Socket_2"] = False
        modifier.show_viewport = False

        return


def export(sceneKey):
    scene = bpy.data.scenes.get(sceneKey)
    
    bpy.context.window.scene = scene

    # add node tree baking
    
    worldShaderTree = bpy.data.scenes[0].world.node_tree
    worldShaderOutput = worldShaderTree.get_output_node('EEVEE')
    worldSurfaceInput = worldShaderOutput.inputs.get('Surface')
    if worldSurfaceInput:
        
        worldSurfaceLinkedNode = worldSurfaceInput.links[0].from_node
        if (worldSurfaceLinkedNode.name == 'Background'):
            worldColorInput = worldSurfaceLinkedNode.inputs.get('Color')
            
            if worldColorInput and worldColorInput.is_linked:
                worldColorNode = worldColorInput.links[0].from_node
                if worldColorNode.name == 'Environment Texture':
                    scene['worldTexture'] = worldColorNode.image
                
            worldStrengthInput = worldSurfaceLinkedNode.inputs.get('Strength')
            if worldStrengthInput:
                scene['worldIntensity'] = worldStrengthInput.default_value

    
    # sceneCollection = scene.collection;
    instanceObjectsToClean = []
    for object in bpy.context.scene.objects:
        prepareAttributesForExport(object)
        if prepareInstancesForExport(object): instanceObjectsToClean.append(object)
    
#    break
    
    bpy.ops.export_scene.gltf(filepath=bpy.path.abspath('//'+sceneKey+'.glb'),
        export_lights =True,
        export_import_convert_lighting_mode='COMPAT',
        gltf_export_id="Sprixle",
        
        export_extras =True,
        export_yup=True,
        export_apply=True,
        export_attributes=True,
        export_normals=True,
        export_texcoords=True,
        export_shared_accessors=True,
        
#        use_mesh_edges=True,
        # use_mesh_vertices =True,

        use_renderable=True,
        use_active_scene=True,
        
        export_animations=True,
#        export_animation_mode='NLA_TRACKS',
#        export_pointer_animation=True,
        export_force_sampling =True,
        export_bake_animation=True,
        export_anim_slide_to_zero=True,
        
        export_gpu_instances=True,
        # export_gn_mesh=True,
        export_original_specular=True,
        
        export_hierarchy_full_collections=True,
        export_cameras=True,
        export_materials='EXPORT',
        export_format='GLB',
        
#        export_texture_dir=bpy.path.abspath('//textures')
    )

    for object in instanceObjectsToClean:
        cleanupInstanceExport(object)