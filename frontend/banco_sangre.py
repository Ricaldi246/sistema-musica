import mysql.connector

conexion = mysql.connector.connect(
    host="bwfn3cq3uoaw9wm4aw62-mysql.services.clever-cloud.com",
    user="u06y23dopsm1i1w9",
    password="lFoq31Lg3SbrTljwUv3s",
    database="bwfn3cq3uoaw9wm4aw62"
)
cursor = conexion.cursor()


def mostrar_tabla(columnas, filas):
    """Imprime los resultados como tabla en consola."""
    if not filas:
        print("\n(Sin resultados)\n")
        return
    anchos = [len(str(c)) for c in columnas]
    for fila in filas:
        for i, valor in enumerate(fila):
            anchos[i] = max(anchos[i], len(str(valor)))
    linea = "+" + "+".join("-" * (a + 2) for a in anchos) + "+"
    print(linea)
    print("| " + " | ".join(str(c).ljust(anchos[i]) for i, c in enumerate(columnas)) + " |")
    print(linea)
    for fila in filas:
        print("| " + " | ".join(str(v).ljust(anchos[i]) for i, v in enumerate(fila)) + " |")
    print(linea)


def consultar(sql):
    cursor.execute(sql)
    columnas = [c[0] for c in cursor.description]
    mostrar_tabla(columnas, cursor.fetchall())


def llamar_procedimiento(nombre, parametros):
    """Ejecuta un procedimiento que devuelve resultados (SELECT)."""
    cursor.callproc(nombre, parametros)
    for resultado in cursor.stored_results():
        mostrar_tabla(resultado.column_names, resultado.fetchall())


def menu():
    print("""
===== BANCO DE SANGRE =====
1. Ver donantes y donaciones
2. Ver donaciones disponibles
3. Ver inventario de sangre por tipo
4. Ver historial de transfusiones
5. Buscar donante por nombre o apellido
6. Ver donaciones disponibles por tipo de sangre
7. Registrar transfusión
0. Salir
""")


try:
    while True:
        menu()
        opcion = input("Elige una opción: ").strip()

        try:
            if opcion == "1":
                consultar("SELECT * FROM vista_donantes_donaciones")
            elif opcion == "2":
                consultar("SELECT * FROM vista_donaciones_disponibles")
            elif opcion == "3":
                consultar("SELECT * FROM vista_inventario_sangre")
            elif opcion == "4":
                consultar("SELECT * FROM vista_historial_transfusiones")
            elif opcion == "5":
                texto = input("Nombre o apellido a buscar: ").strip()
                llamar_procedimiento("sp_buscar_donante", [texto])
            elif opcion == "6":
                tipo = input("Tipo de sangre (ej. O+, A+, O-): ").strip().upper()
                llamar_procedimiento("sp_donaciones_por_tipo", [tipo])
            elif opcion == "7":
                id_paciente = int(input("ID del paciente: "))
                id_donacion = int(input("ID de la donación: "))
                cursor.callproc("sp_registrar_transfusion", [id_paciente, id_donacion])
                conexion.commit()
                print("\nTransfusión registrada correctamente.\n")
            elif opcion == "0":
                print("Hasta luego.")
                break
            else:
                print("Opción no válida.")
        except ValueError:
            print("Debes ingresar un número entero.")
        except mysql.connector.Error as e:
            print(f"\nError de base de datos: {e}\n")

finally:
    cursor.close()
    conexion.close()