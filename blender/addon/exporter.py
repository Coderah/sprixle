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
        


class SprixleExport(bpy.types.Operator):
    """Uses Sprixle addon's export for the current scene"""      # Use this as a tooltip for menu items and buttons.
    bl_idname = "export.sprixle_export"        # Unique identifier for buttons and menu items to reference.
    bl_label = "Sprixle: Export"         # Display name in the interface.

    def execute(self, context):        # execute() is called when running the operator.

        export(bpy.context.scene.name)

        return {'FINISHED'}            # Lets Blender know the operator finished successfully.


def menu_func_export(self, context):
    self.layout.operator(SprixleExport.bl_idname, text="Sprixle Export (.glb)")

def register():
    print('SprixleExport registering')
    # bpy.utils.unregister_class(SprixleExport)
    # bpy.utils.register_class(SprixleExport)
    bpy.types.TOPBAR_MT_file_export.append(menu_func_export)

def unregister():
    bpy.types.TOPBAR_MT_file_export.remove(menu_func_export)
    # bpy.utils.unregister_class(SprixleExport)
