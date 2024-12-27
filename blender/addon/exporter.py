# bl_info = {
#     "name": "Move X Axis",
#     "blender": (2, 80, 0),
#     "category": "Object",
# }

import bpy

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
    
#    break
    
    bpy.ops.export_scene.gltf(filepath=bpy.path.abspath('//'+sceneKey+'.glb'),
        export_lights =True,
        export_import_convert_lighting_mode='COMPAT',
        
        export_extras =True,
        export_yup=True,
        export_apply=True,
        export_attributes=True,
        
#        use_mesh_edges=True,
        use_mesh_vertices =True,
        use_renderable=True,
        use_active_scene=True,
        
        export_animations=True,
#        export_animation_mode='NLA_TRACKS',
#        export_pointer_animation=True,
        export_force_sampling =True,
        export_bake_animation=True,
        export_anim_slide_to_zero=True,
        
        export_gpu_instances=True,
        export_original_specular=True,
        
        export_hierarchy_full_collections=True,
        export_cameras=True,
        export_materials='EXPORT',
        export_format='GLB',
        
#        export_texture_dir=bpy.path.abspath('//textures')
    )